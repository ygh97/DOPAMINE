// 시즌과 엔진 재생. 서버를 다시 켜면 시즌 시작부터 기록된 주문 흐름을 넣으며 엔진을 같은 경로로 다시 돌린다.
// tick은 벽시계 기준: 시즌 시작 뒤 지난 시간 / tickMs. 서버가 꺼져 있던 동안의 시세도 재생으로 채운다.
// 주의: 시즌 중에 엔진 코드를 바꾸면 재생 경로가 달라진다. 엔진 변경은 시즌 사이에 배포한다.
import { ASSETS, SECTORS, SPARES, createMarket, type Market, type MarketOptions } from "@dopamine/engine";
import type { Db } from "./db.ts";

export interface Season { id: number; seed: number; startedAt: number; tickMs: number }

export function currentSeason(db: Db, seed: number, tickMs: number, now = Date.now()): Season {
  const row = db.prepare("SELECT id, seed, started_at, tick_ms FROM seasons ORDER BY id DESC LIMIT 1").get() as
    { id: number; seed: number; started_at: number; tick_ms: number } | undefined;
  if (row) return { id: row.id, seed: row.seed, startedAt: row.started_at, tickMs: row.tick_ms };
  const id = Number(db.prepare("INSERT INTO seasons (seed, started_at, tick_ms) VALUES (?, ?, ?)").run(seed, now, tickMs).lastInsertRowid);
  return { id, seed, startedAt: now, tickMs };
}

export function bootMarket(db: Db, season: Season, options: Partial<MarketOptions>, now = Date.now()): { market: Market; replayed: number; warmTicks: number } {
  const market = createMarket({ assets: ASSETS, sectors: SECTORS, spares: SPARES, seed: season.seed, now: season.startedAt, options });
  const warmTicks = market.tick;
  const target = targetTick(season, warmTicks, now);
  const flows = db.prepare("SELECT tick, sym, notional FROM flows WHERE season_id = ? ORDER BY tick").all(season.id) as
    { tick: number; sym: string; notional: number }[];
  let i = 0;
  while (market.tick < target) {
    const next = market.tick + 1;
    for (; i < flows.length && flows[i].tick <= next; i++) if (flows[i].tick === next) market.applyFlow(flows[i].sym, flows[i].notional);
    market.step();
  }
  return { market, replayed: target - warmTicks, warmTicks };
}

/** 지금 시각에 엔진이 도달해야 하는 tick */
export const targetTick = (season: Season, warmTicks: number, now = Date.now()) =>
  warmTicks + Math.max(0, Math.floor((now - season.startedAt) / season.tickMs));
