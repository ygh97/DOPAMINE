// 계좌·현물·선물 주문·정산·랭킹. GameLoop가 tick마다 settle() → market.step() → applyActions() → checkTriggers() 순서로 부른다.
//
// 체결 규칙 (SPEC 3장):
// - 같은 tick의 주문(현물·선물·강제 청산·스탑로스)은 종목별 순매수 금액으로 충격을 한 번 계산하고(engine.applyFlow) 같은 기준가로 체결한다.
// - 각 주문은 자기 방향으로 최소 슬리피지 0.05%를 더 낸다. 수수료 0.05%는 별도.
// - 현물: 매수는 예수금의 pct%, 매도는 보유 수량의 pct%. 종목당 보유 한도는 가상 유동성 L의 20%.
// - 선물: 격리 증거금 = 예수금의 pct% (진입 수수료 포함). 명목 = 증거금 × 레버리지.
//   증거금의 90%를 잃는 가격에서 강제 청산. 강제 청산·스탑로스는 다음 tick 묶음에 시장가로 들어간다 (갭이면 불리).
import { LEVERAGE, type CorporateAction, type Market, type MarketKind } from "@dopamine/engine";
import { tx, type Db } from "./db.ts";
import type { Season } from "./season.ts";

export const START_CASH = 100_000;
export const GOAL = 10_000_000;
const FEE = 0.0005;
const SLIP = 0.0005;
const HOLD_SHARE = 0.2;
const ORDERS_PER_TICK = 2;      // tick(1초)당 계정별 주문 수
const LIQ_LOSS = 0.9;           // 증거금 손실 90%에서 강제 청산
const RESET_LOCK_TICKS = 600;   // 다시 시작한 뒤 10분간 5배 초과 레버리지 금지
const RESET_MAX_LEV = 5;

export class OrderError extends Error {}

export interface Position { qty: number; avg: number }
export interface Future { id: number; sym: string; side: "long" | "short"; lev: number; qty: number; entry: number; margin: number; stop: number | null; tp: number | null; closing: boolean }
interface Account {
  userId: number; name: string; cash: number; positions: Map<string, Position>; futures: Map<number, Future>;
  clearedTick: number | null; resetAt: number | null;
}
export interface Fill { id: number; tick: number; at: number; sym: string; side: string; qty: number; price: number; fee: number; pnl?: number }
type Settle = { resolve: (f: Fill) => void; reject: (e: Error) => void };
type Pending =
  | ({ kind: "spot"; userId: number; sym: string; side: "buy" | "sell"; pct: number } & Settle)
  | ({ kind: "open"; userId: number; sym: string; side: "long" | "short"; lev: number; pct: number } & Settle)
  | ({ kind: "close"; userId: number; sym: string; posId: number; pct: number; reason: "user" | "liquidation" | "stop" | "tp" } & Partial<Settle>);
export interface RankRow { rank: number; name: string; equity: number; returnPct: number; clearedTick: number | null }

/** 주식·신흥주는 1주 단위, 코인은 0.000001 단위 */
const step = (market: MarketKind) => (market === "coin" ? 1e-6 : 1);
const floorTo = (v: number, s: number) => Math.floor(v / s + 1e-9) * s;
const dirOf = (f: Future) => (f.side === "long" ? 1 : -1);
/** 강제 청산 가격: 증거금의 90%를 잃는 지점 */
export const liqPrice = (f: Pick<Future, "side" | "lev" | "entry">) => f.entry * (1 - (f.side === "long" ? 1 : -1) * LIQ_LOSS / f.lev);
const pnlOf = (f: Future, price: number, qty = f.qty) => dirOf(f) * qty * (price - f.entry);

export class Broker {
  private db: Db;
  private season: Season;
  private market: Market;
  private accounts = new Map<number, Account>();
  private pending: Pending[] = [];
  private broadcasts: string[] = [];
  private recent = new Map<number, { tick: number; count: number }>(); // 주문 속도 제한
  private rankCache: { tick: number; rows: RankRow[]; rankByUser: Map<string, number> } | null = null;
  private stmts;

  constructor(db: Db, season: Season, market: Market) {
    this.db = db; this.season = season; this.market = market;
    this.stmts = {
      selUser: db.prepare("SELECT name FROM users WHERE id = ?"),
      selAcc: db.prepare("SELECT cash, reset_at, cleared_tick FROM accounts WHERE user_id = ? AND season_id = ?"),
      insAcc: db.prepare("INSERT INTO accounts (user_id, season_id, cash) VALUES (?, ?, ?)"),
      selPos: db.prepare("SELECT sym, qty, avg FROM positions WHERE user_id = ? AND season_id = ?"),
      selFut: db.prepare("SELECT id, sym, side, lev, qty, entry, margin, stop, tp FROM futures WHERE user_id = ? AND season_id = ?"),
      selSeasonUsers: db.prepare("SELECT user_id FROM accounts WHERE season_id = ?"),
      selFills: db.prepare("SELECT id, tick, at, sym, side, qty, price, fee, pnl FROM fills WHERE user_id = ? AND season_id = ? ORDER BY id DESC LIMIT 50"),
      delPosAll: db.prepare("DELETE FROM positions WHERE user_id = ? AND season_id = ?"),
      delFutAll: db.prepare("DELETE FROM futures WHERE user_id = ? AND season_id = ?"),
      resetAcc: db.prepare("UPDATE accounts SET cash = ?, reset_at = ? WHERE user_id = ? AND season_id = ?"),
      updStop: db.prepare("UPDATE futures SET stop = ? WHERE id = ?"),
      updTp: db.prepare("UPDATE futures SET tp = ? WHERE id = ?"),
      insFlow: db.prepare("INSERT INTO flows (season_id, tick, sym, notional) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET notional = notional + excluded.notional"),
      updCash: db.prepare("UPDATE accounts SET cash = ? WHERE user_id = ? AND season_id = ?"),
      insFill: db.prepare("INSERT INTO fills (user_id, season_id, tick, at, sym, side, qty, price, fee, pnl) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
      insFut: db.prepare("INSERT INTO futures (user_id, season_id, sym, side, lev, qty, entry, margin, stop, tp, opened_tick) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)"),
      delFut: db.prepare("DELETE FROM futures WHERE id = ?"),
      updFutPart: db.prepare("UPDATE futures SET qty = ?, margin = ? WHERE id = ?"),
      updFutSplit: db.prepare("UPDATE futures SET qty = ?, entry = ?, stop = ?, tp = ? WHERE id = ?"),
      delPos: db.prepare("DELETE FROM positions WHERE user_id = ? AND season_id = ? AND sym = ?"),
      upsertPos: db.prepare("INSERT INTO positions (user_id, season_id, sym, qty, avg) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET qty = excluded.qty, avg = excluded.avg"),
      updCleared: db.prepare("UPDATE accounts SET cleared_tick = ? WHERE user_id = ? AND season_id = ?"),
      selDrawings: db.prepare("SELECT sym, factor, items FROM drawings WHERE user_id = ? AND season_id = ?"),
      delDrawing: db.prepare("DELETE FROM drawings WHERE user_id = ? AND season_id = ? AND sym = ?"),
      upsertDrawing: db.prepare("INSERT INTO drawings (user_id, season_id, sym, factor, items, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, season_id, sym) DO UPDATE SET factor = excluded.factor, items = excluded.items, updated_at = excluded.updated_at"),
      clearDrawings: db.prepare("DELETE FROM drawings WHERE user_id = ? AND season_id = ?"),
    };
  }

  // ---------- 계좌 ----------
  account(userId: number): Account {
    const hit = this.accounts.get(userId);
    if (hit) return hit;
    const sid = this.season.id;
    const user = this.stmts.selUser.get(userId) as { name: string };
    let row = this.stmts.selAcc.get(userId, sid) as
      { cash: number; reset_at: number | null; cleared_tick: number | null } | undefined;
    if (!row) {
      this.stmts.insAcc.run(userId, sid, START_CASH);
      row = { cash: START_CASH, reset_at: null, cleared_tick: null };
    }
    const positions = new Map<string, Position>();
    for (const p of this.stmts.selPos.all(userId, sid) as { sym: string; qty: number; avg: number }[])
      positions.set(p.sym, { qty: p.qty, avg: p.avg });
    const futures = new Map<number, Future>();
    for (const f of this.stmts.selFut.all(userId, sid) as unknown as Future[])
      futures.set(f.id, { ...f, tp: f.tp ?? null, closing: false });
    const acc: Account = { userId, name: user.name, cash: row.cash, positions, futures, clearedTick: row.cleared_tick, resetAt: row.reset_at };
    this.accounts.set(userId, acc);
    this.rankCache = null;
    return acc;
  }
  /** 서버 시작 시 이번 시즌 계좌를 모두 올린다 (랭킹·청산 감시용) */
  loadAll() {
    for (const r of this.stmts.selSeasonUsers.all(this.season.id) as { user_id: number }[]) this.account(r.user_id);
  }
  get players() { return this.accounts.size; }

  private price(sym: string) { return this.market.quote(sym)?.price ?? 0; }
  /** 선물 평가액: 증거금 + 미실현 손익 (0 아래로는 안 내려감, 격리) */
  private futureValue(f: Future) { return Math.max(0, f.margin + pnlOf(f, this.price(f.sym))); }

  equity(acc: Account): number {
    let v = acc.cash;
    for (const [sym, p] of acc.positions) v += p.qty * this.price(sym);
    for (const f of acc.futures.values()) v += this.futureValue(f);
    return v;
  }

  me(userId: number) {
    const acc = this.account(userId);
    const fills = this.stmts.selFills.all(userId, this.season.id) as unknown as Fill[];
    const equity = this.equity(acc);
    this.ensureRankCache();
    return {
      name: acc.name, cash: acc.cash, equity, returnPct: (equity / START_CASH - 1) * 100, goal: GOAL,
      clearedTick: acc.clearedTick, resetAt: acc.resetAt, tick: this.market.tick,
      positions: [...acc.positions].map(([sym, p]) => ({ sym, qty: p.qty, avg: p.avg })),
      futures: [...acc.futures.values()].map(f => ({ id: f.id, sym: f.sym, side: f.side, lev: f.lev, qty: f.qty, entry: f.entry, margin: f.margin, stop: f.stop, tp: f.tp, liq: liqPrice(f) })),
      fills, rank: this.rankCache?.rankByUser.get(acc.name) ?? null,
    };
  }

  reset(userId: number) {
    const acc = this.account(userId);
    tx(this.db, () => {
      this.stmts.delPosAll.run(userId, this.season.id);
      this.stmts.delFutAll.run(userId, this.season.id);
      this.stmts.resetAcc.run(START_CASH, this.market.tick, userId, this.season.id);
    });
    acc.cash = START_CASH; acc.positions.clear(); acc.futures.clear(); acc.resetAt = this.market.tick;
    this.rankCache = null;
  }

  // ---------- 주문 접수 (다음 tick 정산 때 체결되며 Promise가 풀린다) ----------
  private admit(userId: number, sym: string): Account {
    if (!this.market.quote(sym)) throw new OrderError("거래할 수 없는 종목입니다.");
    const r = this.recent.get(userId);
    const count = r && r.tick === this.market.tick ? r.count : 0;
    if (count >= ORDERS_PER_TICK) throw new OrderError("주문이 너무 빠릅니다. 잠시 후 다시 시도하세요.");
    this.recent.set(userId, { tick: this.market.tick, count: count + 1 });
    return this.account(userId);
  }
  private checkPct(pct: number) {
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new OrderError("비중은 0~100% 사이여야 합니다.");
  }

  place(userId: number, sym: string, side: string, pct: number): Promise<Fill> {
    if (side !== "buy" && side !== "sell") throw new OrderError("매수 또는 매도만 할 수 있습니다.");
    this.checkPct(pct);
    const acc = this.admit(userId, sym);
    if (side === "sell" && !acc.positions.get(sym)?.qty) throw new OrderError("보유하지 않은 종목입니다.");
    return new Promise((resolve, reject) => this.pending.push({ kind: "spot", userId, sym, side, pct, resolve, reject }));
  }

  openFuture(userId: number, sym: string, side: string, lev: number, pct: number): Promise<Fill> {
    if (side !== "long" && side !== "short") throw new OrderError("롱 또는 숏만 할 수 있습니다.");
    this.checkPct(pct);
    const q = this.market.quote(sym);
    if (!q) throw new OrderError("거래할 수 없는 종목입니다.");
    if (!LEVERAGE[q.market].includes(lev)) throw new OrderError(`이 종목의 레버리지는 ${LEVERAGE[q.market].join("·")}배만 됩니다.`);
    const acc = this.account(userId);
    if (lev > RESET_MAX_LEV && acc.resetAt != null && this.market.tick - acc.resetAt < RESET_LOCK_TICKS)
      throw new OrderError(`다시 시작한 뒤 10분 동안은 ${RESET_MAX_LEV}배를 넘는 레버리지를 쓸 수 없습니다.`);
    this.admit(userId, sym);
    return new Promise((resolve, reject) => this.pending.push({ kind: "open", userId, sym, side, lev, pct, resolve, reject }));
  }

  closeFuture(userId: number, posId: number, pct: number): Promise<Fill> {
    this.checkPct(pct);
    const f = this.account(userId).futures.get(posId);
    if (!f) throw new OrderError("선물 포지션을 찾을 수 없습니다.");
    if (f.closing) throw new OrderError("이미 청산 중인 포지션입니다.");
    this.admit(userId, f.sym);
    return new Promise((resolve, reject) => this.pending.push({ kind: "close", userId, sym: f.sym, posId, pct, reason: "user", resolve, reject }));
  }

  /** 보유 현물·선물 포지션 일괄 100% 시장가 매도·종료 */
  closeAll(userId: number, scope: "spot" | "futures" | "all" = "all"): Promise<Fill[]> {
    const acc = this.account(userId);
    const r = this.recent.get(userId);
    const count = r && r.tick === this.market.tick ? r.count : 0;
    if (count >= ORDERS_PER_TICK) throw new OrderError("주문이 너무 빠릅니다. 잠시 후 다시 시도하세요.");
    const tasks: Promise<Fill>[] = [];
    if (scope === "spot" || scope === "all") {
      for (const [sym, p] of acc.positions) {
        if (p.qty > 0 && this.market.quote(sym)) {
          tasks.push(new Promise((resolve, reject) => this.pending.push({ kind: "spot", userId, sym, side: "sell", pct: 100, resolve, reject })));
        }
      }
    }
    if (scope === "futures" || scope === "all") {
      for (const f of acc.futures.values()) {
        if (!f.closing && this.market.quote(f.sym)) {
          f.closing = true;
          tasks.push(new Promise((resolve, reject) => this.pending.push({ kind: "close", userId, sym: f.sym, posId: f.id, pct: 100, reason: "user", resolve, reject })));
        }
      }
    }
    if (!tasks.length) throw new OrderError("정리할 보유종목이나 선물 포지션이 없습니다.");
    this.recent.set(userId, { tick: this.market.tick, count: count + 1 });
    return Promise.all(tasks);
  }

  /** 스탑로스 설정·해제 (price = null). 롱은 현재가 아래, 숏은 현재가 위여야 한다 */
  setStop(userId: number, posId: number, price: number | null) {
    const f = this.account(userId).futures.get(posId);
    if (!f) throw new OrderError("선물 포지션을 찾을 수 없습니다.");
    if (price != null) {
      const now = this.price(f.sym);
      if (!Number.isFinite(price) || price <= 0) throw new OrderError("스탑로스 가격이 올바르지 않습니다.");
      if (f.side === "long" ? price >= now : price <= now) throw new OrderError(f.side === "long" ? "롱 스탑로스는 현재가보다 낮아야 합니다." : "숏 스탑로스는 현재가보다 높아야 합니다.");
    }
    f.stop = price;
    this.stmts.updStop.run(price, posId);
  }

  /** 익절(TP) 설정·해제 (price = null). 롱은 현재가 위, 숏은 현재가 아래여야 한다 */
  setTp(userId: number, posId: number, price: number | null) {
    const f = this.account(userId).futures.get(posId);
    if (!f) throw new OrderError("선물 포지션을 찾을 수 없습니다.");
    if (price != null) {
      const now = this.price(f.sym);
      if (!Number.isFinite(price) || price <= 0) throw new OrderError("익절 가격이 올바르지 않습니다.");
      if (f.side === "long" ? price <= now : price >= now) throw new OrderError(f.side === "long" ? "롱 익절가는 현재가보다 높아야 합니다." : "숏 익절가는 현재가보다 낮아야 합니다.");
    }
    f.tp = price;
    this.stmts.updTp.run(price, posId);
  }

  // ---------- tick 정산 ----------
  /** 종목별 순매수로 충격을 반영하고 이번 tick 주문을 체결한다. market.step() 전에 부른다 */
  settle(): { type: string; sym: string }[] {
    if (!this.pending.length) return [];
    const orders = this.pending; this.pending = [];
    this.rankCache = null;
    const auto: { type: string; sym: string }[] = [];
    const tick = this.market.tick + 1, at = Date.now();
    const bySym = new Map<string, Pending[]>();
    for (const o of orders) {
      let arr = bySym.get(o.sym);
      if (!arr) { arr = []; bySym.set(o.sym, arr); }
      arr.push(o);
    }

    for (const [sym, group] of bySym) {
      const q = this.market.quote(sym);
      if (!q) { for (const o of group) o.reject?.(new OrderError("거래가 중지된 종목입니다.")); continue; }
      // 1) 주문별 명목 금액(+ 매수 방향, - 매도 방향)을 지금 가격으로 어림해 순매수를 낸다
      const notional = (o: Pending): number => {
        const acc = this.account(o.userId);
        if (o.kind === "spot") {
          if (o.side === "buy") return (acc.cash * o.pct) / 100 / (1 + FEE + SLIP);
          const held = acc.positions.get(sym)?.qty ?? 0;
          return -floorTo(o.pct >= 100 ? held : (held * o.pct) / 100, step(q.market)) * q.price;
        }
        if (o.kind === "open") return (o.side === "long" ? 1 : -1) * ((acc.cash * o.pct) / 100 / (1 + o.lev * FEE)) * o.lev;
        const f = acc.futures.get(o.posId);
        return f ? -dirOf(f) * f.qty * Math.min(1, o.pct / 100) * q.price : 0;
      };
      const net = group.reduce((s, o) => s + notional(o), 0);
      const flow = this.market.applyFlow(sym, net)!;
      const done: { o: Pending; fill: Fill }[] = [], failed: { o: Pending; err: OrderError }[] = [];
      try {
        tx(this.db, () => {
          if (net) this.stmts.insFlow.run(this.season.id, tick, sym, net);
          for (const o of group) {
            try { done.push({ o, fill: this.execute(o, flow.price, tick, at) }); }
            catch (e) { if (e instanceof OrderError) failed.push({ o, err: e }); else throw e; }
          }
        });
      } catch (e) {
        // DB 쓰기가 실패하면 메모리 계좌를 다시 읽어 맞춘다
        for (const o of group) { this.accounts.delete(o.userId); o.reject?.(new OrderError("주문 처리 중 오류가 났습니다. 보유종목을 확인하세요.")); }
        console.error(e);
        continue;
      }
      for (const { o, fill } of done) {
        o.resolve?.(fill);
        if (o.kind === "close" && o.reason !== "user") auto.push({ type: o.reason, sym: o.sym });
      }
      for (const { o, err } of failed) o.reject?.(err);
    }
    return auto;
  }

  /** 주문 하나 체결. 실패는 OrderError로 던진다 (트랜잭션 안에서 부른다) */
  private execute(o: Pending, base: number, tick: number, at: number): Fill {
    const acc = this.account(o.userId), q = this.market.quote(o.sym)!;
    const record = (side: string, qty: number, price: number, fee: number, pnl?: number): Fill => {
      this.stmts.updCash.run(acc.cash, acc.userId, this.season.id);
      const id = Number(this.stmts.insFill.run(acc.userId, this.season.id, tick, at, o.sym, side, qty, price, fee, pnl ?? null).lastInsertRowid);
      return { id, tick, at, sym: o.sym, side, qty, price, fee, pnl };
    };

    if (o.kind === "spot") {
      const unit = step(q.market), L = this.market.liquidity(o.sym) ?? Infinity;
      const pos = acc.positions.get(o.sym) ?? { qty: 0, avg: 0 };
      if (o.side === "buy") {
        const price = base * (1 + SLIP);
        const room = floorTo((HOLD_SHARE * L) / price - pos.qty, unit);
        if (room <= 0) throw new OrderError(`보유 한도(가상 유동성의 20%, 약 $${Math.round(HOLD_SHARE * L).toLocaleString()})에 도달했습니다.`);
        const qty = Math.min(floorTo((acc.cash * o.pct) / 100 / (price * (1 + FEE)), unit), room);
        if (qty <= 0) throw new OrderError("예수금이 부족해 1주도 살 수 없습니다.");
        const fee = qty * price * FEE;
        acc.cash -= qty * price + fee;
        pos.avg = (pos.qty * pos.avg + qty * price + fee) / (pos.qty + qty); // 평단은 매수 수수료 포함
        pos.qty += qty;
        this.savePosition(acc, o.sym, pos);
        return record("buy", qty, price, fee);
      }
      const price = base * (1 - SLIP);
      const qty = o.pct >= 100 ? pos.qty : floorTo((pos.qty * o.pct) / 100, unit); // 전량은 남김 없이
      if (qty <= 0) throw new OrderError("팔 수량이 없습니다.");
      const fee = qty * price * FEE;
      acc.cash += qty * price - fee;
      pos.qty -= qty;
      this.savePosition(acc, o.sym, pos);
      return record("sell", qty, price, fee, qty * (price - pos.avg) - fee);
    }

    if (o.kind === "open") {
      const dir = o.side === "long" ? 1 : -1, price = base * (1 + dir * SLIP);
      const budget = (acc.cash * o.pct) / 100;
      const margin = budget / (1 + o.lev * FEE), notional = margin * o.lev, fee = notional * FEE;
      if (margin < 1) throw new OrderError("예수금이 부족합니다.");
      acc.cash -= margin + fee;
      const f: Future = { id: 0, sym: o.sym, side: o.side, lev: o.lev, qty: notional / price, entry: price, margin, stop: null, tp: null, closing: false };
      f.id = Number(this.stmts.insFut.run(acc.userId, this.season.id, o.sym, o.side, o.lev, f.qty, f.entry, f.margin, tick).lastInsertRowid);
      acc.futures.set(f.id, f);
      return record(`${o.side}-open`, f.qty, price, fee);
    }

    // 종료 (사용자 / 강제 청산 / 스탑로스)
    const f = acc.futures.get(o.posId);
    if (!f) throw new OrderError("이미 종료된 포지션입니다.");
    f.closing = false;
    const share = Math.min(1, o.pct / 100), price = base * (1 - dirOf(f) * SLIP);
    const qty = f.qty * share, margin = f.margin * share, fee = qty * price * FEE;
    const pnl = pnlOf(f, price, qty);
    acc.cash += Math.max(0, margin + pnl - fee); // 격리: 증거금보다 더 잃지는 않는다
    if (share >= 1) {
      acc.futures.delete(f.id);
      this.stmts.delFut.run(f.id);
    } else {
      f.qty -= qty; f.margin -= margin; // 스탑로스는 남은 포지션에 유지
      this.stmts.updFutPart.run(f.qty, f.margin, f.id);
    }
    const side = o.reason === "liquidation" ? "liquidation" : o.reason === "stop" ? "stop" : o.reason === "tp" ? "tp" : `${f.side}-close`;
    if (o.reason === "liquidation") {
      this.broadcasts.push(`[강제청산] 💥 ${acc.name}님 $${o.sym} ${f.lev}x ${f.side === "long" ? "롱" : "숏"} (증거금 $${Math.round(f.margin).toLocaleString()}) 강제청산!`);
    }
    return record(side, qty, price, fee, pnl);
  }

  /** market.step() 뒤: 강제 청산·스탑로스 조건에 걸린 포지션을 다음 tick 묶음에 시장가 종료로 넣는다 */
  checkTriggers() {
    for (const acc of this.accounts.values()) for (const f of acc.futures.values()) {
      if (f.closing) continue;
      const p = this.price(f.sym), liq = liqPrice(f), long = f.side === "long";
      const liquidate = long ? p <= liq : p >= liq;
      const stopped = f.stop != null && (long ? p <= f.stop : p >= f.stop);
      const tookProfit = f.tp != null && (long ? p >= f.tp : p <= f.tp);
      if (!liquidate && !stopped && !tookProfit) continue;
      f.closing = true;
      this.pending.push({ kind: "close", userId: acc.userId, sym: f.sym, posId: f.id, pct: 100, reason: liquidate ? "liquidation" : stopped ? "stop" : "tp" });
    }
  }

  private savePosition(acc: Account, sym: string, pos: Position) {
    if (pos.qty <= 1e-12) {
      acc.positions.delete(sym);
      this.stmts.delPos.run(acc.userId, this.season.id, sym);
    } else {
      acc.positions.set(sym, pos);
      this.stmts.upsertPos.run(acc.userId, this.season.id, sym, pos.qty, pos.avg);
    }
  }

  // ---------- 상장 변화 정산 ----------
  /** market.step() 뒤에 부른다. 영향을 받은 사용자 id를 돌려준다 */
  applyActions(actions: CorporateAction[]): number[] {
    if (!actions.length) return [];
    const touched = new Set<number>();
    const tick = this.market.tick, at = Date.now();
    const log = (userId: number, sym: string, side: string, qty: number, price: number) =>
      this.stmts.insFill.run(userId, this.season.id, tick, at, sym, side, qty, price, 0, null);
    for (const act of actions) {
      if (act.type !== "split" && act.type !== "delist") continue;
      tx(this.db, () => {
        for (const acc of this.accounts.values()) {
          const pos = acc.positions.get(act.sym);
          const futs = [...acc.futures.values()].filter(f => f.sym === act.sym);
          if (!pos && !futs.length) continue;
          touched.add(acc.userId);
          if (act.type === "split") {
            if (pos) {
              // 주식병합: 수량 ÷ratio, 평단 ×ratio. 1주가 안 되는 단주는 병합 뒤 가격으로 현금 지급
              const price = this.price(act.sym), exact = pos.qty / act.ratio, whole = Math.floor(exact + 1e-9), fraction = exact - whole;
              if (fraction > 1e-9) { acc.cash += fraction * price; log(acc.userId, act.sym, "split-cash", fraction, price); }
              this.savePosition(acc, act.sym, { qty: whole, avg: pos.avg * act.ratio });
            }
            for (const f of futs) {
              f.qty /= act.ratio; f.entry *= act.ratio; if (f.stop != null) f.stop *= act.ratio; if (f.tp != null) f.tp *= act.ratio;
              this.stmts.updFutSplit.run(f.qty, f.entry, f.stop, f.tp, f.id);
            }
          } else {
            // 상장폐지: 마지막 가격으로 전부 정산 (수수료 없음)
            if (pos) { acc.cash += pos.qty * act.price; log(acc.userId, act.sym, "delist", pos.qty, act.price); this.savePosition(acc, act.sym, { qty: 0, avg: 0 }); }
            for (const f of futs) {
              acc.cash += Math.max(0, f.margin + pnlOf(f, act.price));
              log(acc.userId, act.sym, "delist", f.qty, act.price);
              acc.futures.delete(f.id);
              this.stmts.delFut.run(f.id);
            }
          }
          this.stmts.updCash.run(acc.cash, acc.userId, this.season.id);
        }
      });
    }
    if (touched.size) this.rankCache = null;
    return [...touched];
  }

  // ---------- 랭킹 ----------
  private ensureRankCache() {
    if (this.rankCache && this.rankCache.tick === this.market.tick) return this.rankCache;
    const raw = [...this.accounts.values()].map(acc => {
      const equity = this.equity(acc);
      if (equity >= GOAL && acc.clearedTick == null) {
        acc.clearedTick = this.market.tick;
        this.stmts.updCleared.run(acc.clearedTick, acc.userId, this.season.id);
        this.broadcasts.push(`[100배졸업] 🏆 ${acc.name}님이 총자산 $${Math.round(equity).toLocaleString()} 달성으로 100배 졸업에 성공했습니다!`);
      }
      return { name: acc.name, equity, returnPct: (equity / START_CASH - 1) * 100, clearedTick: acc.clearedTick };
    });
    raw.sort((a, b) => b.equity - a.equity || (a.clearedTick ?? Infinity) - (b.clearedTick ?? Infinity));
    const rows = raw.map((r, i) => ({ rank: i + 1, ...r }));
    const rankByUser = new Map<string, number>();
    for (const r of rows) rankByUser.set(r.name, r.rank);
    this.rankCache = { tick: this.market.tick, rows, rankByUser };
    return this.rankCache;
  }

  /** 총자산 순. 같으면 100배를 먼저 달성한 사람이 위. 100배 달성 시점도 여기서 기록한다 */
  ranking(limit = 50): RankRow[] {
    return this.ensureRankCache().rows.slice(0, limit);
  }

  /** 이번 tick에 발생한 전광판 알림(100배 졸업·강제청산)을 꺼낸다 */
  drainBroadcasts(): string[] {
    if (!this.broadcasts.length) return [];
    const out = this.broadcasts;
    this.broadcasts = [];
    return out;
  }

  // ---------- 차트 그리기 서버 보관 ----------
  getDrawings(userId: number): Record<string, { factor: number; items: unknown[] }> {
    const rows = this.stmts.selDrawings.all(userId, this.season.id) as { sym: string; factor: number; items: string }[];
    const out: Record<string, { factor: number; items: unknown[] }> = {};
    for (const r of rows) {
      try { out[r.sym] = { factor: r.factor, items: JSON.parse(r.items) }; } catch { /* 손상된 항목 무시 */ }
    }
    return out;
  }

  saveDrawing(userId: number, sym: string, factor: number, items: unknown[]) {
    if (!sym || sym.length > 12 || !Number.isFinite(factor) || factor <= 0 || !Array.isArray(items))
      throw new OrderError("그리기 데이터 형식이 올바르지 않습니다.");
    if (!items.length) {
      this.stmts.delDrawing.run(userId, this.season.id, sym);
      return;
    }
    const json = JSON.stringify(items.slice(0, 100));
    this.stmts.upsertDrawing.run(userId, this.season.id, sym, factor, json, Date.now());
  }

  clearDrawings(userId: number) {
    this.stmts.clearDrawings.run(userId, this.season.id);
  }
}
