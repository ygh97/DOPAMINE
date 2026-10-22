// 시즌: 시작·엔진 복원·스냅샷·종료와 명예의 전당.
// tick은 벽시계 기준(시즌 시작 뒤 지난 시간 / tickMs). 서버를 다시 켜면 최신 스냅샷에서 시작해,
// 그 뒤로 기록된 주문 흐름(flows)을 넣으며 지금 시각까지 재생한다. 서버가 꺼져 있던 동안의 시세도 채워진다.
// 주의: 스냅샷 이후 구간은 재생이라, 시즌 중에 엔진 코드를 바꾸면 그 구간 경로가 달라질 수 있다.
import { randomInt } from "node:crypto";
import { ASSETS, SECTORS, SPARES, createMarket, type Market, type MarketOptions } from "@dopamine/engine";
import type { RankRow } from "./broker.ts";
import { tx, type Db } from "./db.ts";

export interface Season { id: number; seed: number; startedAt: number; tickMs: number; lengthMs: number }
interface SeasonRow { id: number; seed: number; started_at: number; tick_ms: number; length_ms: number }
const toSeason = (r: SeasonRow): Season => ({ id: r.id, seed: r.seed, startedAt: r.started_at, tickMs: r.tick_ms, lengthMs: r.length_ms });

/** 진행 중인 시즌. 없으면 지금 시작한다. 시즌 길이 설정이 바뀌었으면 진행 중 시즌에도 맞춘다 (이미 지났으면 다음 tick에 종료) */
export function currentSeason(db: Db, seed: number, tickMs: number, lengthMs: number, now = Date.now()): Season {
  const row = db.prepare("SELECT id, seed, started_at, tick_ms, length_ms FROM seasons WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1").get() as SeasonRow | undefined;
  if (row && row.length_ms !== lengthMs) {
    db.prepare("UPDATE seasons SET length_ms = ? WHERE id = ?").run(lengthMs, row.id);
    row.length_ms = lengthMs;
  }
  if (row) return toSeason(row);
  const id = Number(db.prepare("INSERT INTO seasons (seed, started_at, tick_ms, length_ms) VALUES (?, ?, ?, ?)").run(seed, now, tickMs, lengthMs).lastInsertRowid);
  return { id, seed, startedAt: now, tickMs, lengthMs };
}

export function bootMarket(db: Db, season: Season, options: Partial<MarketOptions>, now = Date.now()) {
  const snap = db.prepare("SELECT tick, data FROM snapshots WHERE season_id = ?").get(season.id) as { tick: number; data: string } | undefined;
  const seasonTicks = Math.max(1, Math.floor(season.lengthMs / season.tickMs)); // 시즌 성장(drift)을 시즌 길이에 맞춘다
  const market = createMarket({ assets: ASSETS, sectors: SECTORS, spares: SPARES, seed: season.seed, now: season.startedAt, options: { seasonTicks, ...options }, snapshot: snap?.data });
  const warmTicks = market.options.warmupBars * market.options.ticksPerBar;
  const target = Math.min(targetTick(season, warmTicks, now), endTick(season, warmTicks));
  const flows = db.prepare("SELECT tick, sym, notional FROM flows WHERE season_id = ? AND tick > ? ORDER BY tick").all(season.id, market.tick) as
    { tick: number; sym: string; notional: number }[];
  const from = market.tick;
  let i = 0;
  while (market.tick < target) {
    const next = market.tick + 1;
    for (; i < flows.length && flows[i].tick <= next; i++) if (flows[i].tick === next) market.applyFlow(flows[i].sym, flows[i].notional);
    market.step();
  }
  return { market, warmTicks, replayed: market.tick - from, fromSnapshot: !!snap };
}

export function saveSnapshot(db: Db, season: Season, market: Market) {
  db.prepare("INSERT INTO snapshots (season_id, tick, data, saved_at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET tick = excluded.tick, data = excluded.data, saved_at = excluded.saved_at")
    .run(season.id, market.tick, market.snapshot(), Date.now());
}

/** 지금 시각에 엔진이 도달해야 하는 tick */
export const targetTick = (season: Season, warmTicks: number, now = Date.now()) =>
  warmTicks + Math.max(0, Math.floor((now - season.startedAt) / season.tickMs));
/** 시즌이 끝나는 tick */
export const endTick = (season: Season, warmTicks: number) => warmTicks + Math.floor(season.lengthMs / season.tickMs);

/**
 * 시즌을 닫고 다음 시즌을 연다. 명예의 전당: 100배 전설을 달성한 사람 전원.
 * 다음 시즌은 이전 시즌이 끝난 시각에 이어서 시작한다 (서버가 오래 꺼져 있었으면 지금부터).
 */
export function finishSeason(db: Db, season: Season, ranking: RankRow[], now = Date.now()): Season {
  const end = season.startedAt + season.lengthMs;
  const start = now - end < season.lengthMs ? end : now;
  const seed = randomInt(1, 2 ** 31);
  return tx(db, () => {
    const add = db.prepare("INSERT OR IGNORE INTO hall_of_fame (season_id, rank, name, equity, return_pct, cleared_tick) VALUES (?, ?, ?, ?, ?, ?)");
    // 명예의 전당은 100배 전설을 달성한 사람만 (봇 제외). 순위는 사람끼리 다시 매긴다. 예전 시즌 기록(1~3위)은 그대로 둔다
    const people = ranking.filter(r => r.kind === "user").map((r, i) => ({ ...r, rank: i + 1 }));
    for (const r of people) if (r.clearedTick != null) add.run(season.id, r.rank, r.name, r.equity, r.returnPct, r.clearedTick);
    db.prepare("UPDATE seasons SET ended_at = ? WHERE id = ?").run(now, season.id);
    db.prepare("DELETE FROM snapshots WHERE season_id = ?").run(season.id);
    const id = Number(db.prepare("INSERT INTO seasons (seed, started_at, tick_ms, length_ms) VALUES (?, ?, ?, ?)").run(seed, start, season.tickMs, season.lengthMs).lastInsertRowid);
    return { id, seed, startedAt: start, tickMs: season.tickMs, lengthMs: season.lengthMs };
  });
}

/** 시즌 끝 통계 (졸업률 보정용 로그): 종류별 참가자·졸업자 수, 사람 상위 10명 수익률 */
export function seasonStats(ranking: RankRow[]) {
  const by = (kind: string) => ranking.filter(r => r.kind === kind);
  const people = by("user"), bots = by("bot");
  return {
    people: people.length, peopleGrad: people.filter(r => r.gradTick != null).length, peopleLegend: people.filter(r => r.clearedTick != null).length,
    bots: bots.length, botsGrad: bots.filter(r => r.gradTick != null).length, botsLegend: bots.filter(r => r.clearedTick != null).length,
    top10ReturnPct: people.slice(0, 10).map(r => Math.round(r.returnPct)),
  };
}

export function hallOfFame(db: Db, seasons = 10) {
  return db.prepare(`SELECT season_id AS season, rank, name, equity, return_pct AS returnPct, cleared_tick AS clearedTick FROM hall_of_fame
    WHERE season_id IN (SELECT id FROM seasons WHERE ended_at IS NOT NULL ORDER BY id DESC LIMIT ?) ORDER BY season_id DESC, rank`).all(seasons);
}
