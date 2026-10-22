// 시즌: 시작·엔진 복원·스냅샷·종료와 명예의 전당.
// tick은 벽시계 기준(시즌 시작 뒤 지난 시간 / tickMs). 서버를 다시 켜면 최신 스냅샷에서 시작해,
// 그 뒤로 기록된 주문 흐름(flows)을 넣으며 지금 시각까지 재생한다. 서버가 꺼져 있던 동안의 시세도 채워진다.
// 주의: 스냅샷 이후 구간은 재생이라, 시즌 중에 엔진 코드를 바꾸면 그 구간 경로가 달라질 수 있다.
import { randomInt } from "node:crypto";
import { ASSETS, Exchange, SECTORS, SPARES, createMarket, type ExchangeOptions, type MarketOptions } from "@dopamine/engine";
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

/**
 * 시즌의 엔진과 호가창을 띄운다. 스냅샷이 있으면 거기서부터, 그 뒤로 기록된 tick별 순매수(flows)를 같은 순서로 넣으며 지금 시각까지 재생한다.
 * 순서는 실제 운영과 같다: tick T로 넘어간 뒤, T 동안 체결된 순매수를 기준가에 남기고(absorbFlow), 다음 tick으로.
 * 재생 중에는 주문을 다시 체결하지 않는다 (계좌는 DB에 바로 저장돼 있다). 걸어 둔 지정가는 Broker.restoreOrders()가 다시 건다
 */
export function bootMarket(db: Db, season: Season, options: Partial<MarketOptions>, now = Date.now(), exchangeOptions: Partial<ExchangeOptions> = {}) {
  const snap = db.prepare("SELECT tick, data, exchange FROM snapshots WHERE season_id = ?").get(season.id) as { tick: number; data: string; exchange: string | null } | undefined;
  const seasonTicks = Math.max(1, Math.floor(season.lengthMs / season.tickMs)); // 시즌 성장(drift)을 시즌 길이에 맞춘다
  const market = createMarket({ assets: ASSETS, sectors: SECTORS, spares: SPARES, seed: season.seed, now: season.startedAt, options: { seasonTicks, ...options }, snapshot: snap?.data });
  const warmTicks = market.options.warmupBars * market.options.ticksPerBar;
  const target = Math.min(targetTick(season, warmTicks, now), endTick(season, warmTicks));
  const flows = db.prepare("SELECT tick, sym, notional FROM flows WHERE season_id = ? AND tick >= ? ORDER BY tick").all(season.id, market.tick) as
    { tick: number; sym: string; notional: number }[];
  const exchange = new Exchange(market, exchangeOptions);
  if (snap?.exchange) exchange.restore(snap.exchange);
  const from = market.tick;
  let i = 0;
  const absorb = () => { for (; i < flows.length && flows[i].tick <= market.tick; i++) if (flows[i].tick === market.tick) market.absorbFlow(flows[i].sym, flows[i].notional); };
  absorb(); // 스냅샷을 저장한 tick 동안 체결된 몫
  while (market.tick < target) { exchange.step(); absorb(); }
  return { market, exchange, warmTicks, replayed: market.tick - from, fromSnapshot: !!snap };
}

export function saveSnapshot(db: Db, season: Season, exchange: Exchange) {
  db.prepare("INSERT INTO snapshots (season_id, tick, data, exchange, saved_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET tick = excluded.tick, data = excluded.data, exchange = excluded.exchange, saved_at = excluded.saved_at")
    .run(season.id, exchange.market.tick, exchange.market.snapshot(), exchange.snapshot(), Date.now());
}

/** 지금 시각에 엔진이 도달해야 하는 tick */
export const targetTick = (season: Season, warmTicks: number, now = Date.now()) =>
  warmTicks + Math.max(0, Math.floor((now - season.startedAt) / season.tickMs));
/** 시즌이 끝나는 tick */
export const endTick = (season: Season, warmTicks: number) => warmTicks + Math.floor(season.lengthMs / season.tickMs);

/**
 * 시즌을 닫고 다음 시즌을 연다. 명예의 전당: 100배 전설을 달성한 사람 전원.
 * 다음 시즌은 이전 시즌이 끝난 시각에 이어서 시작한다 (서버가 오래 꺼져 있었거나 운영자가 일찍 끝냈으면 지금부터).
 */
export function finishSeason(db: Db, season: Season, ranking: RankRow[], now = Date.now()): Season {
  const end = season.startedAt + season.lengthMs;
  const start = now >= end && now - end < season.lengthMs ? end : now; // 일찍 끝냈으면(운영자 새 시즌) 지금부터
  const seed = randomInt(1, 2 ** 31);
  return tx(db, () => {
    const add = db.prepare("INSERT OR IGNORE INTO hall_of_fame (season_id, rank, name, equity, return_pct, cleared_tick) VALUES (?, ?, ?, ?, ?, ?)");
    // 명예의 전당은 100배 전설을 달성한 사람만 (봇 제외). 순위는 사람끼리 다시 매긴다. 예전 시즌 기록(1~3위)은 그대로 둔다
    const people = ranking.filter(r => r.kind === "user").map((r, i) => ({ ...r, rank: i + 1 }));
    for (const r of people) if (r.clearedTick != null) add.run(season.id, r.rank, r.name, r.equity, r.returnPct, r.clearedTick);
    db.prepare("UPDATE seasons SET ended_at = ? WHERE id = ?").run(now, season.id);
    db.prepare("DELETE FROM snapshots WHERE season_id = ?").run(season.id);
    db.prepare("DELETE FROM open_orders WHERE season_id = ?").run(season.id); // 지정가는 시즌 끝까지만
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

/** 명예의 전당: 끝난 시즌 번호(최근 limit개, 오래된 순)와 그 시즌들의 전설. 전설이 없던 시즌도 번호는 나온다 (화면의 시즌 탭) */
export function hallOfFame(db: Db, limit = 30) {
  const seasons = (db.prepare("SELECT id FROM seasons WHERE ended_at IS NOT NULL ORDER BY id DESC LIMIT ?").all(limit) as { id: number }[]).map(r => r.id).reverse();
  const rows = db.prepare(`SELECT season_id AS season, rank, name, equity, return_pct AS returnPct, cleared_tick AS clearedTick FROM hall_of_fame
    WHERE season_id IN (SELECT id FROM seasons WHERE ended_at IS NOT NULL ORDER BY id DESC LIMIT ?) ORDER BY season_id DESC, rank`).all(limit) as
    { season: number; rank: number; name: string; equity: number; returnPct: number; clearedTick: number | null }[];
  return { seasons, rows };
}
