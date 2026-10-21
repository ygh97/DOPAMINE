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

/** 진행 중인 시즌. 없으면 지금 시작한다 */
export function currentSeason(db: Db, seed: number, tickMs: number, lengthMs: number, now = Date.now()): Season {
  const row = db.prepare("SELECT id, seed, started_at, tick_ms, length_ms FROM seasons WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1").get() as SeasonRow | undefined;
  if (row) return toSeason(row);
  const id = Number(db.prepare("INSERT INTO seasons (seed, started_at, tick_ms, length_ms) VALUES (?, ?, ?, ?)").run(seed, now, tickMs, lengthMs).lastInsertRowid);
  return { id, seed, startedAt: now, tickMs, lengthMs };
}

export function bootMarket(db: Db, season: Season, options: Partial<MarketOptions>, now = Date.now()) {
  const snap = db.prepare("SELECT tick, data FROM snapshots WHERE season_id = ?").get(season.id) as { tick: number; data: string } | undefined;
  const market = createMarket({ assets: ASSETS, sectors: SECTORS, spares: SPARES, seed: season.seed, now: season.startedAt, options, snapshot: snap?.data });
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
 * 시즌을 닫고 다음 시즌을 연다. 명예의 전당: 1~3위 + 100배 달성자 전원.
 * 다음 시즌은 이전 시즌이 끝난 시각에 이어서 시작한다 (서버가 오래 꺼져 있었으면 지금부터).
 */
export function finishSeason(db: Db, season: Season, ranking: RankRow[], now = Date.now()): Season {
  const end = season.startedAt + season.lengthMs;
  const start = now - end < season.lengthMs ? end : now;
  const seed = randomInt(1, 2 ** 31);
  return tx(db, () => {
    const add = db.prepare("INSERT OR IGNORE INTO hall_of_fame (season_id, rank, name, equity, return_pct, cleared_tick) VALUES (?, ?, ?, ?, ?, ?)");
    for (const r of ranking) if (r.rank <= 3 || r.clearedTick != null) add.run(season.id, r.rank, r.name, r.equity, r.returnPct, r.clearedTick);
    db.prepare("UPDATE seasons SET ended_at = ? WHERE id = ?").run(now, season.id);
    db.prepare("DELETE FROM snapshots WHERE season_id = ?").run(season.id);
    const id = Number(db.prepare("INSERT INTO seasons (seed, started_at, tick_ms, length_ms) VALUES (?, ?, ?, ?)").run(seed, start, season.tickMs, season.lengthMs).lastInsertRowid);
    return { id, seed, startedAt: start, tickMs: season.tickMs, lengthMs: season.lengthMs };
  });
}

export function hallOfFame(db: Db, seasons = 10) {
  return db.prepare(`SELECT season_id AS season, rank, name, equity, return_pct AS returnPct, cleared_tick AS clearedTick FROM hall_of_fame
    WHERE season_id IN (SELECT id FROM seasons WHERE ended_at IS NOT NULL ORDER BY id DESC LIMIT ?) ORDER BY season_id DESC, rank`).all(seasons);
}
