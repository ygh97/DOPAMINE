// 계좌 기본층: 타입·상수·도우미, 계좌 읽기, 평가액, 체결 기록, 걸어 둔 지정가 장부, 순매수 흐름.
// 위층(broker-positions.ts → broker-orders.ts → broker.ts)이 이 클래스를 이어받는다. 상태 필드는 모두 여기에만 둔다.
import { qtyUnit, type Exchange, type Market, type Side } from "@dopamine/engine";
import { tx, type Db } from "../db.ts";
import type { Season } from "../season.ts";

export const START_CASH = 100_000;
export const MM_CASH = 10_000_000;  // 🏦 세력 계정 시작 자금 (2026-10-24 전: $200만)
export const WHALE_CASH = 5_000_000; // 🐋 고래 계정 시작 자금 (2026-10-24 전: $200만)
export const GRAD = 5_000_000;    // 50배 = 졸업 (2026-10-23 전: 20배)
export const GOAL = 10_000_000;   // 100배 = 전설 (명예의 전당)
export const FEE = 0.0005;              // 시장가(호가를 먹는 쪽) 수수료. 지정가로 걸어 둔 쪽은 0
export const MAX_OPEN_ORDERS = 20;      // 1인 미체결 지정가 최대
export const MAX_CASCADE = 50;          // 한 번에 이어서 처리하는 강제 청산·스탑 최대 건수
export const ORDERS_PER_TICK = 2;      // tick(1초)당 계정별 주문 수
export const LIQ_LOSS = 0.9;           // 증거금 손실 90%에서 강제 청산
export const RESET_LOCK_TICKS = 600;   // 다시 시작한 뒤 10분간 10배 레버리지 금지 (2026-10-24 하루 없앴다가 되돌림, 기준은 5배 초과 → 10배)
export const RESET_LOCKED_LEV = 10;
export const PEAK_MS = 14_280_000;     // 마감 3시간 58분 전(20:00)부터 체결하면 그날 LP 감점 절반
export const LATE_RESET_MS = 3_480_000; // 마감 58분 전(23:00)부터 다시 시작하면 그날은 손실 마감으로 정산
export const CROWD_TICKS = 120;  // 단합 감지 구간: 최근 2분

export class OrderError extends Error {}

export interface Position { qty: number; avg: number }
export interface Future { id: number; sym: string; side: "long" | "short"; lev: number; qty: number; entry: number; margin: number; stop: number | null; tp: number | null; closing: boolean }
/**
 * user: 사람, bot: 🤖 봇, mm: 🏦 세력, whale: 🐋 고래.
 * 봇은 랭킹에 나오지만 졸업 알림·명예의 전당에서 빠진다. 세력·고래는 랭킹 밖 자기 탭에 나온다
 */
export type AccountKind = "user" | "bot" | "mm" | "whale";
export interface Account {
  userId: number; name: string; kind: AccountKind; cash: number; positions: Map<string, Position>; futures: Map<number, Future>;
  /** clearedTick: 100배 전설이 된 tick (100배 아래로 내려가면 null), gradTick: 50배 졸업 달성 tick */
  clearedTick: number | null; gradTick: number | null; resetAt: number | null;
  /** 🤖 봇 교대로 쉬는 중: 매매하지 않고 랭킹에서 숨는다 (메모리만) */
  resting?: boolean;
}
export const startCash = (kind: AccountKind) => (kind === "mm" ? MM_CASH : kind === "whale" ? WHALE_CASH : START_CASH);
export interface Fill { id: number; tick: number; at: number; sym: string; side: string; qty: number; price: number; fee: number; pnl?: number }
/**
 * 걸어 둔 지정가 하나 (거래소 주문 id = id). qty = 남은 수량.
 * cash = 묶어 둔 돈 (현물 매수 대금, 선물 증거금+수수료), held/avg = 현물 매도로 보유에서 떼어 둔 수량과 그 평단.
 * posId = 선물 지정가가 체결되며 만든 포지션 (같은 주문의 체결은 한 포지션으로 모은다).
 * reduce = 선물 종료 지정가: posId 포지션만 줄인다 (새 포지션을 만들지 않고, 돈을 묶지 않는다).
 * 한 포지션의 종료 지정가 수량 합은 늘 포지션 수량 이하다 (걸 때 막고, 포지션이 줄면 최근 것부터 취소) → 가짜 호가벽을 못 세운다
 */
export interface Intent {
  id: number; userId: number; sym: string; kind: "spot" | "fut"; side: Side; lev: number; price: number; qty: number;
  cash: number; held: number; avg: number; posId: number | null; seq: number; filled?: number; reduce?: boolean;
}
export interface RankRow { rank: number; name: string; kind: AccountKind; equity: number; returnPct: number; clearedTick: number | null; gradTick: number | null }
/** 세력 전략이 보는 종목별 쏠림: 사람·봇의 현물 평가액, 선물 롱·숏 명목, 청산가 목록 */
export interface Exposure { spot: number; long: number; short: number; liqs: { price: number; notional: number; side: "long" | "short" }[] }

/** 주식·신흥주는 1주 단위, 코인은 0.000001 단위 (현물·선물·호가 모두). 그래야 체결 수량이 늘 단위의 배수다 */
export const step = qtyUnit;
export const floorTo = (v: number, s: number) => Math.floor(v / s + 1e-9) * s;
export const dirOf = (f: Future) => (f.side === "long" ? 1 : -1);
/** 수량 표시 (오류 문구용): 코인은 소수 6자리, 나머지는 주 */
export const qtyLabel = (q: number, unit: number) => (unit < 1 ? `${+q.toFixed(6)}개` : `${Math.floor(q + 1e-9).toLocaleString()}주`);
/**
 * 주문 수량 정하기: qty(직접 입력)가 있으면 단위로 내려 맞추고 최대치를 넘으면 거절, 없으면 최대치의 pct%.
 * all = pct 100%일 때 최대치를 그대로 쓸지 (보유 전량 매도처럼 남김 없이)
 */
export function pickQty(max: number, unit: number, pct: number, qty: number | undefined, tooMuch: string, all = false) {
  if (qty != null) {
    if (!Number.isFinite(qty) || qty <= 0) throw new OrderError("수량이 올바르지 않습니다.");
    const q = floorTo(qty, unit);
    if (q <= 0) throw new OrderError(`최소 ${qtyLabel(unit, unit)} 단위로 주문할 수 있습니다.`);
    if (q > max + 1e-9) throw new OrderError(`${tooMuch} (최대 ${qtyLabel(max, unit)})`);
    return q;
  }
  return all && pct >= 100 ? max : floorTo((max * pct) / 100, unit);
}
/** 강제 청산 가격: 증거금의 90%를 잃는 지점 */
export const liqPrice = (f: Pick<Future, "side" | "lev" | "entry">) => f.entry * (1 - (f.side === "long" ? 1 : -1) * LIQ_LOSS / f.lev);
export const pnlOf = (f: Future, price: number, qty = f.qty) => dirOf(f) * qty * (price - f.entry);

export class BrokerCore {
  protected db: Db;
  protected season: Season;
  protected x: Exchange;
  protected market: Market;
  protected accounts = new Map<number, Account>();
  protected intents = new Map<number, Intent>();          // 걸어 둔 지정가 (거래소 주문 id → 내용)
  protected tickFlows = new Map<string, number>();        // 이번 tick 종목별 순매수 (시장가 쪽, 엔진에 남기고 재생용으로 기록)
  protected crowdFlows = new Map<string, number>();       // 그중 세력 계정을 뺀 것
  protected humanFlows: { tick: number; userId: number; sym: string; signed: number }[] = []; // 최근 2분 사람 계정의 순매수 (단합 감지)
  protected autoClosed: { type: string; sym: string }[] = [];
  protected makerTouched = new Set<string>(); // 지정가가 체결된 종목
  protected stuck = new Set<Future>();                    // 호가가 없어 이번 tick 청산하지 못한 포지션
  protected broadcasts: string[] = [];
  protected legendAnnounced = new Set<number>();           // 이번 시즌 [전설] 전광판 알림을 이미 띄운 사람
  protected recent = new Map<number, { tick: number; count: number }>(); // 주문 속도 제한
  protected rankCache: { tick: number; rows: RankRow[]; people: RankRow[]; bots: RankRow[]; mm: RankRow[]; whales: RankRow[]; rankByUser: Map<string, number> } | null = null;
  /** 직전 정산의 종목별 순매수 명목 (세력 계정 주문 제외). 유동성 공급 세력이 반대편을 받는 데 쓴다 */
  lastFlows = new Map<string, number>();
  protected stmts;

  constructor(db: Db, season: Season, exchange: Exchange) {
    this.db = db; this.season = season; this.x = exchange; this.market = exchange.market;
    this.stmts = {
      selUser: db.prepare("SELECT name, kind FROM users WHERE id = ?"),
      selAcc: db.prepare("SELECT cash, reset_at, cleared_tick, grad_tick FROM accounts WHERE user_id = ? AND season_id = ?"),
      insAcc: db.prepare("INSERT INTO accounts (user_id, season_id, cash) VALUES (?, ?, ?)"),
      selPos: db.prepare("SELECT sym, qty, avg FROM positions WHERE user_id = ? AND season_id = ?"),
      selFut: db.prepare("SELECT id, sym, side, lev, qty, entry, margin, stop, tp FROM futures WHERE user_id = ? AND season_id = ?"),
      selSeasonUsers: db.prepare("SELECT user_id FROM accounts WHERE season_id = ?"),
      // 다시 시작한 뒤의 체결만 (내 체결 내역·실현손익·승률이 새로 시작한다. 기록은 DB에 남는다)
      selFills: db.prepare("SELECT id, tick, at, sym, side, qty, price, fee, pnl FROM fills WHERE user_id = ? AND season_id = ? AND tick >= ? ORDER BY id DESC LIMIT 50"),
      selSymFills: db.prepare("SELECT id, tick, at, sym, side, qty, price, fee, pnl FROM fills WHERE user_id = ? AND season_id = ? AND sym = ? AND tick >= ? ORDER BY id"),
      selFill: db.prepare("SELECT id, tick, at, sym, side, qty, price, fee, pnl FROM fills WHERE id = ? AND user_id = ? AND season_id = ?"),
      delPosAll: db.prepare("DELETE FROM positions WHERE user_id = ? AND season_id = ?"),
      delFutAll: db.prepare("DELETE FROM futures WHERE user_id = ? AND season_id = ?"),
      resetAcc: db.prepare("UPDATE accounts SET cash = ?, reset_at = ? WHERE user_id = ? AND season_id = ?"),
      updStop: db.prepare("UPDATE futures SET stop = ? WHERE id = ?"),
      updTp: db.prepare("UPDATE futures SET tp = ? WHERE id = ?"),
      insFlow: db.prepare("INSERT INTO flows (season_id, tick, sym, notional) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET notional = notional + excluded.notional"),
      updCash: db.prepare("UPDATE accounts SET cash = ? WHERE user_id = ? AND season_id = ?"),
      updActivity: db.prepare("UPDATE accounts SET base_equity = COALESCE(base_equity, ?), turnover = turnover + ?, peak_trade = MAX(peak_trade, ?) WHERE user_id = ? AND season_id = ?"),
      updLateReset: db.prepare("UPDATE accounts SET late_reset = 1 WHERE user_id = ? AND season_id = ?"),
      insFill: db.prepare("INSERT INTO fills (user_id, season_id, tick, at, sym, side, qty, price, fee, pnl) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
      insFut: db.prepare("INSERT INTO futures (user_id, season_id, sym, side, lev, qty, entry, margin, stop, tp, opened_tick) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)"),
      delFut: db.prepare("DELETE FROM futures WHERE id = ?"),
      updFutPart: db.prepare("UPDATE futures SET qty = ?, margin = ? WHERE id = ?"),
      updFutSplit: db.prepare("UPDATE futures SET qty = ?, entry = ?, stop = ?, tp = ? WHERE id = ?"),
      delPos: db.prepare("DELETE FROM positions WHERE user_id = ? AND season_id = ? AND sym = ?"),
      upsertPos: db.prepare("INSERT INTO positions (user_id, season_id, sym, qty, avg) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET qty = excluded.qty, avg = excluded.avg"),
      updCleared: db.prepare("UPDATE accounts SET cleared_tick = ? WHERE user_id = ? AND season_id = ?"),
      updGrad: db.prepare("UPDATE accounts SET grad_tick = ? WHERE user_id = ? AND season_id = ?"),
      selDrawings: db.prepare("SELECT sym, factor, items FROM drawings WHERE user_id = ? AND season_id = ?"),
      delDrawing: db.prepare("DELETE FROM drawings WHERE user_id = ? AND season_id = ? AND sym = ?"),
      upsertDrawing: db.prepare("INSERT INTO drawings (user_id, season_id, sym, factor, items, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, season_id, sym) DO UPDATE SET factor = excluded.factor, items = excluded.items, updated_at = excluded.updated_at"),
      clearDrawings: db.prepare("DELETE FROM drawings WHERE user_id = ? AND season_id = ?"),
      updFutOpen: db.prepare("UPDATE futures SET qty = ?, entry = ?, margin = ? WHERE id = ?"),
      upsertOrder: db.prepare("INSERT INTO open_orders (id, user_id, season_id, sym, kind, side, lev, price, qty, cash, held, avg, pos_id, seq, filled, reduce) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET qty = excluded.qty, cash = excluded.cash, held = excluded.held, pos_id = excluded.pos_id, filled = excluded.filled"),
      delOrder: db.prepare("DELETE FROM open_orders WHERE id = ?"),
      selOrders: db.prepare('SELECT id, user_id AS "userId", sym, kind, side, lev, price, qty, cash, held, avg, pos_id, seq, filled, reduce FROM open_orders WHERE season_id = ? ORDER BY seq'),
    };
  }

  // ---------- 계좌 ----------
  account(userId: number): Account {
    const hit = this.accounts.get(userId);
    if (hit) return hit;
    const sid = this.season.id;
    const user = this.stmts.selUser.get(userId) as { name: string; kind: AccountKind };
    let row = this.stmts.selAcc.get(userId, sid) as
      { cash: number; reset_at: number | null; cleared_tick: number | null; grad_tick: number | null } | undefined;
    if (!row) {
      this.stmts.insAcc.run(userId, sid, startCash(user.kind));
      row = { cash: startCash(user.kind), reset_at: null, cleared_tick: null, grad_tick: null };
    }
    const positions = new Map<string, Position>();
    for (const p of this.stmts.selPos.all(userId, sid) as { sym: string; qty: number; avg: number }[])
      positions.set(p.sym, { qty: p.qty, avg: p.avg });
    const futures = new Map<number, Future>();
    for (const f of this.stmts.selFut.all(userId, sid) as unknown as Future[]) {
      // 예전에 따로 열린 같은 종목·방향·배율 포지션은 불러올 때 하나로 합친다 (익절·손절은 먼저 연 쪽, 없으면 나중 쪽)
      const g = [...futures.values()].find(x => x.sym === f.sym && x.side === f.side && x.lev === f.lev);
      if (!g) { futures.set(f.id, { ...f, tp: f.tp ?? null, closing: false }); continue; }
      g.entry = (g.entry * g.qty + f.entry * f.qty) / (g.qty + f.qty); g.qty += f.qty; g.margin += f.margin;
      g.stop ??= f.stop; g.tp ??= f.tp;
      this.stmts.updFutOpen.run(g.qty, g.entry, g.margin, g.id); this.stmts.updStop.run(g.stop, g.id); this.stmts.updTp.run(g.tp, g.id); this.stmts.delFut.run(f.id); // 주문 트랜잭션 안에서 불릴 수 있어 tx로 감싸지 않는다
    }
    const acc: Account = { userId, name: user.name, kind: user.kind, cash: row.cash, positions, futures, clearedTick: row.cleared_tick, gradTick: row.grad_tick, resetAt: row.reset_at };
    this.accounts.set(userId, acc);
    this.rankCache = null;
    return acc;
  }
  /** 서버 시작 시 이번 시즌 계좌를 모두 올린다 (랭킹·청산 감시용) */
  loadAll() {
    for (const r of this.stmts.selSeasonUsers.all(this.season.id) as { user_id: number }[]) this.account(r.user_id);
  }
  /** 랭킹에 나오는 참가자 수 (사람 + 봇, 세력 제외) */
  get players() { let n = 0; for (const a of this.accounts.values()) if ((a.kind === "user" || a.kind === "bot") && !a.resting) n++; return n; }

  /** 종목별 사람·봇의 쏠림 (세력 전략용). 계좌 수 × 포지션 수만큼 돌므로 매 tick이 아니라 가끔 부른다 */
  exposure(): Map<string, Exposure> {
    const out = new Map<string, Exposure>();
    const get = (sym: string) => { let e = out.get(sym); if (!e) { e = { spot: 0, long: 0, short: 0, liqs: [] }; out.set(sym, e); } return e; };
    for (const acc of this.accounts.values()) {
      if (acc.kind === "mm") continue;
      for (const [sym, p] of acc.positions) get(sym).spot += p.qty * this.price(sym);
      for (const f of acc.futures.values()) {
        const e = get(f.sym), notional = f.qty * this.price(f.sym);
        if (f.side === "long") e.long += notional; else e.short += notional;
        e.liqs.push({ price: liqPrice(f), notional, side: f.side });
      }
    }
    return out;
  }

  protected price(sym: string) { return this.x.price(sym); }
  /** 선물 평가액: 증거금 + 미실현 손익 (0 아래로는 안 내려감, 격리) */
  protected futureValue(f: Future) { return Math.max(0, f.margin + pnlOf(f, this.price(f.sym))); }

  equity(acc: Account): number {
    let v = acc.cash;
    for (const [sym, p] of acc.positions) v += p.qty * this.price(sym);
    for (const f of acc.futures.values()) v += this.futureValue(f);
    for (const it of this.intents.values()) if (it.userId === acc.userId) v += it.cash + it.held * this.price(it.sym); // 묶어 둔 돈·수량
    return v;
  }

  /** fresh: 🤖 봇이 새 봇으로 바뀔 때. 졸업·전설 기록도 지운다 (사람의 다시 시작은 기록을 남긴다) */
  reset(userId: number, fresh = false) {
    const acc = this.account(userId);
    if (fresh) { acc.gradTick = null; acc.clearedTick = null; this.stmts.updGrad.run(null, userId, this.season.id); this.stmts.updCleared.run(null, userId, this.season.id); }
    for (const it of [...this.intents.values()]) if (it.userId === userId) { this.x.cancel(userId, it.id); this.release(acc, it); }
    tx(this.db, () => {
      this.stmts.delPosAll.run(userId, this.season.id);
      this.stmts.delFutAll.run(userId, this.season.id);
      this.stmts.resetAcc.run(startCash(acc.kind), this.market.tick, userId, this.season.id);
      if (acc.kind === "user" && this.untilEnd() <= LATE_RESET_MS) this.stmts.updLateReset.run(userId, this.season.id);
    });
    acc.cash = startCash(acc.kind); acc.positions.clear(); acc.futures.clear(); acc.resetAt = this.market.tick;
    this.rankCache = null;
  }

  /** 한 번의 주문을 트랜잭션으로 묶는다. DB가 실패하면 메모리 계좌를 버리고 다시 읽는다 */
  protected atomic<T>(userIds: number[], fn: () => T): T {
    try { return tx(this.db, fn); }
    catch (e) {
      if (e instanceof OrderError) throw e;
      for (const id of userIds) this.accounts.delete(id);
      console.error(e);
      throw new OrderError("주문 처리 중 오류가 났습니다. 보유종목을 확인하세요.");
    }
  }
  protected record(acc: Account, sym: string, side: string, qty: number, price: number, fee: number, pnl?: number): Fill {
    const tick = this.market.tick, at = Date.now();
    this.stmts.updCash.run(acc.cash, acc.userId, this.season.id);
    const id = Number(this.stmts.insFill.run(acc.userId, this.season.id, tick, at, sym, side, qty, price, fee, pnl ?? null).lastInsertRowid);
    if (acc.kind === "user") this.stmts.updActivity.run(this.equity(acc), qty * price, this.untilEnd() <= PEAK_MS ? 1 : 0, acc.userId, this.season.id); // LP 활동 기록
    this.rankCache = null;
    return { id, tick, at, sym, side, qty, price, fee, pnl };
  }
  /** 시즌 마감까지 남은 시간 (ms, tick 기준: 시즌 시계와 같다) */
  protected untilEnd() {
    const o = this.market.options;
    return this.season.lengthMs - (this.market.tick - o.warmupBars * o.ticksPerBar) * this.season.tickMs;
  }
  protected addFlow(acc: Account, sym: string, signed: number) {
    if (!signed) return;
    this.tickFlows.set(sym, (this.tickFlows.get(sym) ?? 0) + signed);
    if (acc.kind !== "mm") this.crowdFlows.set(sym, (this.crowdFlows.get(sym) ?? 0) + signed);
    if (acc.kind === "user") this.humanFlows.push({ tick: this.market.tick, userId: acc.userId, sym, signed });
  }
  /**
   * 단합 감지: 최근 2분(CROWD_TICKS) 동안 사람 계정의 순매수를 사람마다 합쳐 방향을 정하고,
   * 종목마다 금액이 큰 쪽 방향의 인원·합계를 돌려준다 (봇·세력·고래는 세지 않는다)
   */
  crowds(): Map<string, { dir: 1 | -1; users: number; notional: number }> {
    const net = new Map<string, Map<number, number>>();
    for (const f of this.humanFlows) {
      let m = net.get(f.sym);
      if (!m) net.set(f.sym, (m = new Map()));
      m.set(f.userId, (m.get(f.userId) ?? 0) + f.signed);
    }
    const out = new Map<string, { dir: 1 | -1; users: number; notional: number }>();
    for (const [sym, m] of net) {
      let bu = 0, bn = 0, su = 0, sn = 0;
      for (const v of m.values()) if (v > 0) { bu++; bn += v; } else if (v < 0) { su++; sn -= v; }
      out.set(sym, bn >= sn ? { dir: 1, users: bu, notional: bn } : { dir: -1, users: su, notional: sn });
    }
    return out;
  }

  ordersOf(userId: number) { return [...this.intents.values()].filter(it => it.userId === userId).map(it => this.orderView(it)); }
  protected orderView(it: Intent) {
    // cash = 묶어 둔 돈, held = 현물 매도로 떼어 둔 수량 (화면이 총자산에 더한다)
    return { id: it.id, sym: it.sym, kind: it.kind, side: it.side, lev: it.lev, price: it.price, qty: it.qty, filled: it.filled ?? 0, cash: it.cash, held: it.held, reduce: !!it.reduce, posId: it.reduce ? it.posId : null };
  }
  /** 주문이 끝나거나 취소됨: 남은 묶음을 돌려주고 지운다 */
  protected release(acc: Account, it: Intent) {
    if (it.cash > 1e-9) acc.cash += it.cash;
    if (it.held > 1e-12) {
      const pos = acc.positions.get(it.sym) ?? { qty: 0, avg: 0 };
      pos.avg = (pos.qty * pos.avg + it.held * it.avg) / (pos.qty + it.held); pos.qty += it.held;
      this.savePosition(acc, it.sym, pos);
    }
    it.cash = 0; it.held = 0;
    this.stmts.updCash.run(acc.cash, acc.userId, this.season.id);
    if (it.id) { this.intents.delete(it.id); this.stmts.delOrder.run(it.id); }
    this.rankCache = null;
  }
  protected saveIntent(it: Intent) {
    this.stmts.upsertOrder.run(it.id, it.userId, this.season.id, it.sym, it.kind, it.side, it.lev, it.price, it.qty, it.cash, it.held, it.avg, it.posId, it.seq, it.filled ?? 0, it.reduce ? 1 : 0);
  }

  protected savePosition(acc: Account, sym: string, pos: Position) {
    if (pos.qty <= 1e-12) {
      acc.positions.delete(sym);
      this.stmts.delPos.run(acc.userId, this.season.id, sym);
    } else {
      acc.positions.set(sym, pos);
      this.stmts.upsertPos.run(acc.userId, this.season.id, sym, pos.qty, pos.avg);
    }
  }
}
