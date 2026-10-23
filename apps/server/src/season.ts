// 시즌: 시작·엔진 복원·스냅샷·종료와 명예의 전당.
// 운영 시즌은 매일 고정 일정이다: 00:00 시작, 23:58 종료, 2분 쉬고 다음 시즌 (서버 PC의 현지 시각). SEASON_MS를 주면 고정 길이(테스트용).
// tick은 벽시계 기준(시즌 시작 뒤 지난 시간 / tickMs). 서버가 꺼져 있던 동안은 시세가 멈춘다:
// 켤 때 꺼져 있던 시간만큼 시즌 시작(started_at)을 미뤄, 시즌 시계가 마지막 tick에서 이어진다 (currentSeason).
// 매일 일정에서는 종료 시각(23:58)은 그대로 두고 시즌 길이를 그만큼 줄인다.
// 그다음 최신 스냅샷에서 시작해 그 뒤로 기록된 주문 흐름(flows)을 넣으며 마지막 tick까지 재생한다.
// 주의: 스냅샷 이후 구간은 재생이라, 시즌 중에 엔진 코드를 바꾸면 그 구간 경로가 달라질 수 있다.
import { randomInt } from "node:crypto";
import { ASSETS, Exchange, SECTORS, SPARES, createMarket, type ExchangeOptions, type MarketOptions } from "@dopamine/engine";
import type { RankRow } from "./broker.ts";
import { tx, type Db } from "./db.ts";

export interface Season { id: number; seed: number; startedAt: number; tickMs: number; lengthMs: number }
interface SeasonRow { id: number; seed: number; started_at: number; tick_ms: number; length_ms: number; last_seen_at: number | null }
const toSeason = (r: SeasonRow): Season => ({ id: r.id, seed: r.seed, startedAt: r.started_at, tickMs: r.tick_ms, lengthMs: r.length_ms });

/** 매일 일정: t가 속한 날의 시즌 종료 시각 (현지 23:58) */
export function dailyEnd(t: number) {
  const d = new Date(t);
  d.setHours(23, 58, 0, 0);
  return d.getTime();
}
/**
 * 매일 일정: t 이후 시즌이 열리는 시각. 오늘 종료 1분 전보다 이르면 지금, 아니면 다음 날 00:00.
 * (시즌 끝 tick은 23:58 직전 몇 초 안에 올 수 있다. 그 순간 "지금부터 23:58까지" 몇 초짜리 시즌을 만들면 안 된다)
 */
export function dailyStart(t: number) {
  if (t < dailyEnd(t) - 60_000) return t;
  const d = new Date(t);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}
/** 새 시즌의 시작·길이. lengthMs가 null이면 매일 일정, 숫자면 지금부터 그 길이 */
export function scheduleSeason(now: number, lengthMs: number | null) {
  if (lengthMs != null) return { startedAt: now, lengthMs };
  const startedAt = dailyStart(now);
  return { startedAt, lengthMs: dailyEnd(startedAt) - startedAt };
}

/**
 * 진행 중인 시즌. 없으면 일정대로 연다. lengthMs가 null이면 매일 일정(00:00~23:58), 숫자면 고정 길이:
 * 고정 길이 설정이 바뀌었으면 진행 중 시즌에도 맞춘다 (이미 지났으면 다음 tick에 종료).
 * 서버가 꺼져 있었으면 그 시간(마지막 tick 시각 last_seen_at부터 지금까지)만큼 시즌 시작을 미룬다: 아무도 못 들어오는 동안 시세가 돌지 않는다.
 * 매일 일정에서는 종료 시각을 지키려고 길이도 그만큼 줄인다
 */
export function currentSeason(db: Db, seed: number, tickMs: number, lengthMs: number | null, now = Date.now()): Season {
  const row = db.prepare("SELECT id, seed, started_at, tick_ms, length_ms, last_seen_at FROM seasons WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1").get() as SeasonRow | undefined;
  if (row && lengthMs != null && row.length_ms !== lengthMs) {
    db.prepare("UPDATE seasons SET length_ms = ? WHERE id = ?").run(lengthMs, row.id);
    row.length_ms = lengthMs;
  }
  if (row && row.last_seen_at != null && now - row.last_seen_at > row.tick_ms) {
    const off = now - row.last_seen_at;
    row.started_at += off;
    if (lengthMs == null) row.length_ms -= off;
    db.prepare("UPDATE seasons SET started_at = ?, length_ms = ?, last_seen_at = ? WHERE id = ?").run(row.started_at, row.length_ms, now, row.id);
  }
  if (row) return toSeason(row);
  const s = scheduleSeason(now, lengthMs);
  const id = Number(db.prepare("INSERT INTO seasons (seed, started_at, tick_ms, length_ms) VALUES (?, ?, ?, ?)").run(seed, s.startedAt, tickMs, s.lengthMs).lastInsertRowid);
  return { id, seed, tickMs, ...s };
}

/**
 * 시즌의 엔진과 호가창을 띄운다. 스냅샷이 있으면 거기서부터, 그 뒤로 기록된 tick별 순매수(flows)를 같은 순서로 넣으며 지금 시각까지 재생한다.
 * 순서는 실제 운영과 같다: tick T로 넘어간 뒤, T 동안 체결된 순매수를 기준가에 남기고(absorbFlow), 다음 tick으로.
 * 재생 중에는 주문을 다시 체결하지 않는다 (계좌는 DB에 바로 저장돼 있다). 걸어 둔 지정가는 Broker.restoreOrders()가 다시 건다
 */
export function bootMarket(db: Db, season: Season, options: Partial<MarketOptions>, now = Date.now(), exchangeOptions: Partial<ExchangeOptions> = {}) {
  const snap = db.prepare("SELECT tick, data, exchange FROM snapshots WHERE season_id = ?").get(season.id) as { tick: number; data: string; exchange: string | null } | undefined;
  const seasonTicks = Math.max(1, Math.floor(season.lengthMs / season.tickMs)); // 시즌 성장(drift)을 시즌 길이에 맞춘다
  const make = (snapshot?: string) => createMarket({ assets: ASSETS, sectors: SECTORS, spares: SPARES, seed: season.seed, now: season.startedAt, options: { seasonTicks, ...options }, snapshot });
  // 엔진 코드가 바뀌어 스냅샷을 못 읽으면 시즌을 버리지 않고 seed + 기록된 순매수로 처음부터 다시 재생한다 (지난 차트 모양은 조금 달라진다)
  let market, useSnap = !!snap;
  try { market = make(snap?.data); }
  catch (e) { console.error("스냅샷을 읽지 못해 시즌 처음부터 재생합니다", e); market = make(); useSnap = false; }
  const warmTicks = market.options.warmupBars * market.options.ticksPerBar;
  const target = Math.min(targetTick(season, warmTicks, now), endTick(season, warmTicks));
  const flows = db.prepare("SELECT tick, sym, notional FROM flows WHERE season_id = ? AND tick >= ? ORDER BY tick").all(season.id, market.tick) as
    { tick: number; sym: string; notional: number }[];
  const exchange = new Exchange(market, exchangeOptions);
  if (useSnap && snap?.exchange) {
    try { exchange.restore(snap.exchange); } catch (e) { console.error("호가창 스냅샷을 읽지 못해 새로 깝니다", e); }
  }
  const from = market.tick;
  let i = 0;
  const absorb = () => { for (; i < flows.length && flows[i].tick <= market.tick; i++) if (flows[i].tick === market.tick) market.absorbFlow(flows[i].sym, flows[i].notional); };
  absorb(); // 스냅샷을 저장한 tick 동안 체결된 몫
  while (market.tick < target) { exchange.step(); absorb(); }
  return { market, exchange, warmTicks, replayed: market.tick - from, fromSnapshot: useSnap };
}

export function saveSnapshot(db: Db, season: Season, exchange: Exchange) {
  db.prepare("INSERT INTO snapshots (season_id, tick, data, exchange, saved_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET tick = excluded.tick, data = excluded.data, exchange = excluded.exchange, saved_at = excluded.saved_at")
    .run(season.id, exchange.market.tick, exchange.market.snapshot(), exchange.snapshot(), Date.now());
}

/** tick을 돌린 시각을 남긴다. 다음에 켤 때 이 시각부터 꺼져 있던 시간을 잰다 */
export function touchSeason(db: Db, season: Season, now = Date.now()) {
  db.prepare("UPDATE seasons SET last_seen_at = ? WHERE id = ?").run(now, season.id);
}

/** 지금 시각에 엔진이 도달해야 하는 tick */
export const targetTick = (season: Season, warmTicks: number, now = Date.now()) =>
  warmTicks + Math.max(0, Math.floor((now - season.startedAt) / season.tickMs));
/** 시즌이 끝나는 tick */
export const endTick = (season: Season, warmTicks: number) => warmTicks + Math.floor(season.lengthMs / season.tickMs);

/** 시즌 엠블럼: 그 시즌에 100배 전설이 되면 영구로 받는다 (S11부터는 다시 처음부터) */
export const SEASON_EMBLEMS = ["🔥", "💎", "🚀", "🌙", "⚡", "🐉", "🦄", "🌋", "🪐", "👑"];
export const emblemOf = (season: number) => SEASON_EMBLEMS[(season - 1) % SEASON_EMBLEMS.length];

/**
 * 시즌을 닫고 다음 시즌을 연다. 명예의 전당: 100배 전설을 달성한 사람 전원 + 시즌 최종 순위 사람 1·2·3등(TOP 3).
 * 다음 시즌: 매일 일정(lengthMs null)이면 다음 00:00 (그날 23:58 전에 끝냈으면 지금부터).
 * 고정 길이면 이전 시즌이 끝난 시각에 이어서 (서버가 오래 꺼져 있었거나 운영자가 일찍 끝냈으면 지금부터).
 */
export function finishSeason(db: Db, season: Season, ranking: RankRow[], now = Date.now(), lengthMs: number | null = season.lengthMs): Season {
  const end = season.startedAt + season.lengthMs;
  const next = lengthMs == null ? scheduleSeason(now, null)
    : { startedAt: now >= end && now - end < lengthMs ? end : now, lengthMs }; // 일찍 끝냈으면(운영자 새 시즌) 지금부터
  const seed = randomInt(1, 2 ** 31);
  return tx(db, () => {
    const add = db.prepare("INSERT OR IGNORE INTO hall_of_fame (season_id, rank, name, equity, return_pct, cleared_tick) VALUES (?, ?, ?, ?, ?, ?)");
    // 명예의 전당은 100배 전설을 달성한 사람만 (봇 제외). 순위는 사람끼리 다시 매긴다. 예전 시즌 기록(1~3위)은 그대로 둔다
    const people = ranking.filter(r => r.kind === "user").map((r, i) => ({ ...r, rank: i + 1 }));
    for (const r of people) if (r.clearedTick != null) add.run(season.id, r.rank, r.name, r.equity, r.returnPct, r.clearedTick);
    const top = db.prepare("INSERT OR IGNORE INTO season_top3 (season_id, rank, name, equity, return_pct) VALUES (?, ?, ?, ?, ?)");
    for (const r of people.slice(0, 3)) top.run(season.id, r.rank, r.name, r.equity, r.returnPct);
    db.prepare("UPDATE seasons SET ended_at = ? WHERE id = ?").run(now, season.id);
    db.prepare("DELETE FROM snapshots WHERE season_id = ?").run(season.id);
    db.prepare("DELETE FROM open_orders WHERE season_id = ?").run(season.id); // 지정가는 시즌 끝까지만
    const id = Number(db.prepare("INSERT INTO seasons (seed, started_at, tick_ms, length_ms) VALUES (?, ?, ?, ?)").run(seed, next.startedAt, season.tickMs, next.lengthMs).lastInsertRowid);
    return { id, seed, tickMs: season.tickMs, ...next };
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

/** 명예의 전당: 끝난 시즌 번호(최근 limit개, 오래된 순), 그 시즌들의 전설(rows)과 TOP 3(top3, 한마디 포함). 전설이 없던 시즌도 번호는 나온다 (화면의 시즌 탭) */
export function hallOfFame(db: Db, limit = 30) {
  const seasons = (db.prepare("SELECT id FROM seasons WHERE ended_at IS NOT NULL ORDER BY id DESC LIMIT ?").all(limit) as { id: number }[]).map(r => r.id).reverse();
  const rows = db.prepare(`SELECT season_id AS season, rank, name, equity, return_pct AS returnPct, cleared_tick AS clearedTick FROM hall_of_fame
    WHERE season_id IN (SELECT id FROM seasons WHERE ended_at IS NOT NULL ORDER BY id DESC LIMIT ?) ORDER BY season_id DESC, rank`).all(limit) as
    { season: number; rank: number; name: string; equity: number; returnPct: number; clearedTick: number | null }[];
  const top3 = db.prepare(`SELECT season_id AS season, rank, name, equity, return_pct AS returnPct, message FROM season_top3
    WHERE season_id IN (SELECT id FROM seasons WHERE ended_at IS NOT NULL ORDER BY id DESC LIMIT ?) ORDER BY season_id DESC, rank`).all(limit) as
    { season: number; rank: number; name: string; equity: number; returnPct: number; message: string | null }[];
  return { seasons, rows, top3 };
}

export interface Badges { emblems: { season: number; icon: string }[]; medals: { season: number; rank: number }[] }
/**
 * 이름별 배지: 시즌 엠블럼(그 시즌 100배 전설, 진행 중 시즌은 달성하는 순간부터)과 TOP 3 메달.
 * 채팅·랭킹 이름 옆에 붙는다. 1등 메달이 하나라도 있으면 화면이 이름을 금색으로 칠한다
 */
export function badgesOf(db: Db, currentSeason: number): Record<string, Badges> {
  const out: Record<string, Badges> = {};
  const get = (name: string) => (out[name] ??= { emblems: [], medals: [] });
  const legends = db.prepare(`SELECT season_id AS season, name FROM hall_of_fame
    UNION SELECT a.season_id, u.name FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.season_id = ? AND a.cleared_tick IS NOT NULL AND u.kind = 'user'
    ORDER BY 1`).all(currentSeason) as { season: number; name: string }[];
  for (const l of legends) get(l.name).emblems.push({ season: l.season, icon: emblemOf(l.season) });
  for (const t of db.prepare("SELECT season_id AS season, rank, name FROM season_top3 ORDER BY season_id").all() as { season: number; rank: number; name: string }[])
    get(t.name).medals.push({ season: t.season, rank: t.rank });
  return out;
}

/** TOP 3 본인이 명예의 전당에 한마디 (50자). 그 시즌 TOP 3가 아니면 false */
export function setTop3Message(db: Db, season: number, name: string, message: string) {
  return Number(db.prepare("UPDATE season_top3 SET message = ? WHERE season_id = ? AND name = ? COLLATE NOCASE").run(message || null, season, name).changes) > 0;
}
