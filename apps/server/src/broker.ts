// 계좌·현물 주문·정산·랭킹. GameLoop가 tick마다 settle() → market.step() → applyActions() 순서로 부른다.
//
// 체결 규칙 (SPEC 3장):
// - 같은 tick의 주문은 종목별 순매수 금액으로 충격을 한 번 계산하고(engine.applyFlow) 같은 기준가로 체결한다.
// - 각 주문은 자기 방향으로 최소 슬리피지 0.05%를 더 낸다. 수수료 0.05%는 별도.
// - 매수는 예수금의 pct%, 매도는 보유 수량의 pct%. 수수료까지 예산 안에서 계산한다.
// - 종목당 보유 한도: 가상 유동성 L의 20%.
import type { CorporateAction, Market, MarketKind } from "@dopamine/engine";
import { tx, type Db } from "./db.ts";
import type { Season } from "./season.ts";

export const START_CASH = 100_000;
export const GOAL = 10_000_000;
const FEE = 0.0005;
const SLIP = 0.0005;
const HOLD_SHARE = 0.2;
const ORDERS_PER_TICK = 2; // tick(1초)당 계정별 주문 수

export class OrderError extends Error {}

export interface Position { qty: number; avg: number }
interface Account { userId: number; name: string; cash: number; positions: Map<string, Position>; clearedTick: number | null; resetAt: number | null }
export interface Fill { id: number; tick: number; at: number; sym: string; side: string; qty: number; price: number; fee: number }
interface Pending {
  userId: number; sym: string; side: "buy" | "sell"; pct: number;
  resolve: (f: Fill) => void; reject: (e: Error) => void;
}
export interface RankRow { rank: number; name: string; equity: number; returnPct: number; clearedTick: number | null }

/** 주식·신흥주는 1주 단위, 코인은 0.000001 단위 */
const step = (market: MarketKind) => (market === "coin" ? 1e-6 : 1);
const floorTo = (v: number, s: number) => Math.floor(v / s + 1e-9) * s;

export class Broker {
  private db: Db;
  private season: Season;
  private market: Market;
  private accounts = new Map<number, Account>();
  private pending: Pending[] = [];
  private recent = new Map<number, { tick: number; count: number }>(); // 주문 속도 제한

  constructor(db: Db, season: Season, market: Market) {
    this.db = db; this.season = season; this.market = market;
  }
  setMarket(market: Market) { this.market = market; }

  // ---------- 계좌 ----------
  account(userId: number): Account {
    const hit = this.accounts.get(userId);
    if (hit) return hit;
    const sid = this.season.id;
    const user = this.db.prepare("SELECT name FROM users WHERE id = ?").get(userId) as { name: string };
    let row = this.db.prepare("SELECT cash, reset_at, cleared_tick FROM accounts WHERE user_id = ? AND season_id = ?").get(userId, sid) as
      { cash: number; reset_at: number | null; cleared_tick: number | null } | undefined;
    if (!row) {
      this.db.prepare("INSERT INTO accounts (user_id, season_id, cash) VALUES (?, ?, ?)").run(userId, sid, START_CASH);
      row = { cash: START_CASH, reset_at: null, cleared_tick: null };
    }
    const positions = new Map<string, Position>();
    for (const p of this.db.prepare("SELECT sym, qty, avg FROM positions WHERE user_id = ? AND season_id = ?").all(userId, sid) as { sym: string; qty: number; avg: number }[])
      positions.set(p.sym, { qty: p.qty, avg: p.avg });
    const acc: Account = { userId, name: user.name, cash: row.cash, positions, clearedTick: row.cleared_tick, resetAt: row.reset_at };
    this.accounts.set(userId, acc);
    return acc;
  }
  /** 서버 시작 시 이번 시즌 계좌를 모두 올린다 (랭킹 계산용) */
  loadAll() {
    for (const r of this.db.prepare("SELECT user_id FROM accounts WHERE season_id = ?").all(this.season.id) as { user_id: number }[]) this.account(r.user_id);
  }

  equity(acc: Account): number {
    let v = acc.cash;
    for (const [sym, p] of acc.positions) v += p.qty * (this.market.quote(sym)?.price ?? 0);
    return v;
  }

  me(userId: number) {
    const acc = this.account(userId);
    const fills = this.db.prepare("SELECT id, tick, at, sym, side, qty, price, fee FROM fills WHERE user_id = ? AND season_id = ? ORDER BY id DESC LIMIT 50")
      .all(userId, this.season.id) as unknown as Fill[];
    const equity = this.equity(acc);
    return {
      name: acc.name, cash: acc.cash, equity, returnPct: (equity / START_CASH - 1) * 100, goal: GOAL,
      clearedTick: acc.clearedTick, resetAt: acc.resetAt,
      positions: [...acc.positions].map(([sym, p]) => ({ sym, qty: p.qty, avg: p.avg })),
      fills, rank: this.ranking().findIndex(r => r.name === acc.name) + 1 || null,
    };
  }

  reset(userId: number) {
    const acc = this.account(userId);
    tx(this.db, () => {
      this.db.prepare("DELETE FROM positions WHERE user_id = ? AND season_id = ?").run(userId, this.season.id);
      this.db.prepare("UPDATE accounts SET cash = ?, reset_at = ? WHERE user_id = ? AND season_id = ?").run(START_CASH, this.market.tick, userId, this.season.id);
    });
    acc.cash = START_CASH; acc.positions.clear(); acc.resetAt = this.market.tick;
  }

  // ---------- 주문 ----------
  /** 주문을 이번 tick 묶음에 넣는다. 다음 tick 정산 때 체결되며 Promise가 풀린다 */
  place(userId: number, sym: string, side: string, pct: number): Promise<Fill> {
    const q = this.market.quote(sym);
    if (!q) throw new OrderError("거래할 수 없는 종목입니다.");
    if (side !== "buy" && side !== "sell") throw new OrderError("매수 또는 매도만 할 수 있습니다.");
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new OrderError("비중은 0~100% 사이여야 합니다.");
    const r = this.recent.get(userId);
    const count = r && r.tick === this.market.tick ? r.count : 0;
    if (count >= ORDERS_PER_TICK) throw new OrderError("주문이 너무 빠릅니다. 잠시 후 다시 시도하세요.");
    this.recent.set(userId, { tick: this.market.tick, count: count + 1 });
    const acc = this.account(userId);
    if (side === "sell" && !acc.positions.get(sym)?.qty) throw new OrderError("보유하지 않은 종목입니다.");
    return new Promise((resolve, reject) => this.pending.push({ userId, sym, side, pct, resolve, reject }));
  }

  /** tick 정산: 종목별 순매수로 충격을 반영하고 주문을 체결한다. market.step() 전에 부른다 */
  settle() {
    if (!this.pending.length) return;
    const orders = this.pending; this.pending = [];
    const tick = this.market.tick + 1, at = Date.now();
    const bySym = new Map<string, Pending[]>();
    for (const o of orders) bySym.set(o.sym, [...(bySym.get(o.sym) ?? []), o]);

    for (const [sym, group] of bySym) {
      const q = this.market.quote(sym);
      if (!q) { for (const o of group) o.reject(new OrderError("거래가 중지된 종목입니다.")); continue; }
      const L = this.market.liquidity(sym) ?? Infinity, unit = step(q.market);
      // 1) 주문별 명목 금액을 지금 가격으로 어림해 순매수를 낸다
      const intents = group.map(o => {
        const acc = this.account(o.userId);
        if (o.side === "buy") return { o, notional: (acc.cash * o.pct) / 100 / (1 + FEE + SLIP) };
        const held = acc.positions.get(sym)?.qty ?? 0;
        return { o, notional: -floorTo(o.pct >= 100 ? held : (held * o.pct) / 100, unit) * q.price };
      });
      const net = intents.reduce((s, i) => s + i.notional, 0);
      const flow = this.market.applyFlow(sym, net)!;
      // 2) 같은 기준가로 체결 (자기 방향으로 최소 슬리피지)
      const fills: { o: Pending; fill: Fill }[] = [];
      try {
        tx(this.db, () => {
          if (net) this.db.prepare("INSERT INTO flows (season_id, tick, sym, notional) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET notional = notional + excluded.notional")
            .run(this.season.id, tick, sym, net);
          for (const { o } of intents) {
            const acc = this.account(o.userId);
            const pos = acc.positions.get(sym) ?? { qty: 0, avg: 0 };
            let qty: number, price: number;
            if (o.side === "buy") {
              price = flow.price * (1 + SLIP);
              const budget = (acc.cash * o.pct) / 100;
              qty = floorTo(budget / (price * (1 + FEE)), unit);
              const room = floorTo((HOLD_SHARE * L) / price - pos.qty, unit);
              if (room <= 0) { o.reject(new OrderError(`보유 한도(가상 유동성의 20%, 약 $${Math.round(HOLD_SHARE * L).toLocaleString()})에 도달했습니다.`)); continue; }
              qty = Math.min(qty, room);
              if (qty <= 0) { o.reject(new OrderError("예수금이 부족해 1주도 살 수 없습니다.")); continue; }
            } else {
              price = flow.price * (1 - SLIP);
              qty = floorTo(o.pct >= 100 ? pos.qty : (pos.qty * o.pct) / 100, unit);
              if (o.pct >= 100) qty = pos.qty; // 전량은 단위와 상관없이 남김 없이
              if (qty <= 0) { o.reject(new OrderError("팔 수량이 없습니다.")); continue; }
            }
            const fee = qty * price * FEE;
            if (o.side === "buy") {
              acc.cash -= qty * price + fee;
              pos.avg = (pos.qty * pos.avg + qty * price + fee) / (pos.qty + qty); // 평단은 매수 수수료 포함
              pos.qty += qty;
            } else {
              acc.cash += qty * price - fee;
              pos.qty -= qty;
            }
            this.savePosition(acc, sym, pos);
            this.db.prepare("UPDATE accounts SET cash = ? WHERE user_id = ? AND season_id = ?").run(acc.cash, acc.userId, this.season.id);
            const id = Number(this.db.prepare("INSERT INTO fills (user_id, season_id, tick, at, sym, side, qty, price, fee) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
              .run(acc.userId, this.season.id, tick, at, sym, o.side, qty, price, fee).lastInsertRowid);
            fills.push({ o, fill: { id, tick, at, sym, side: o.side, qty, price, fee } });
          }
        });
      } catch (e) {
        // DB 쓰기가 실패하면 메모리 계좌를 다시 읽어 맞춘다
        for (const o of group) { this.accounts.delete(o.userId); o.reject(new OrderError("주문 처리 중 오류가 났습니다. 보유종목을 확인하세요.")); }
        console.error(e);
        continue;
      }
      for (const { o, fill } of fills) o.resolve(fill);
    }
  }

  private savePosition(acc: Account, sym: string, pos: Position) {
    if (pos.qty <= 1e-12) {
      acc.positions.delete(sym);
      this.db.prepare("DELETE FROM positions WHERE user_id = ? AND season_id = ? AND sym = ?").run(acc.userId, this.season.id, sym);
    } else {
      acc.positions.set(sym, pos);
      this.db.prepare("INSERT INTO positions (user_id, season_id, sym, qty, avg) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET qty = excluded.qty, avg = excluded.avg")
        .run(acc.userId, this.season.id, sym, pos.qty, pos.avg);
    }
  }

  // ---------- 상장 변화 정산 ----------
  /** market.step() 뒤에 부른다. 영향을 받은 사용자 id를 돌려준다 */
  applyActions(actions: CorporateAction[]): number[] {
    const touched = new Set<number>();
    const tick = this.market.tick, at = Date.now();
    for (const act of actions) {
      if (act.type !== "split" && act.type !== "delist") continue;
      const holders = this.db.prepare("SELECT user_id FROM positions WHERE season_id = ? AND sym = ?").all(this.season.id, act.sym) as { user_id: number }[];
      tx(this.db, () => {
        for (const { user_id } of holders) {
          const acc = this.account(user_id), pos = acc.positions.get(act.sym);
          if (!pos) continue;
          touched.add(user_id);
          if (act.type === "split") {
            // 주식병합: 수량 ÷ratio, 평단 ×ratio. 1주가 안 되는 단주는 병합 뒤 가격으로 현금 지급
            const price = this.market.quote(act.sym)?.price ?? 0;
            const exact = pos.qty / act.ratio, whole = Math.floor(exact + 1e-9), fraction = exact - whole;
            const avg = pos.avg * act.ratio;
            if (fraction > 1e-9) {
              acc.cash += fraction * price;
              this.db.prepare("INSERT INTO fills (user_id, season_id, tick, at, sym, side, qty, price, fee) VALUES (?, ?, ?, ?, ?, 'split-cash', ?, ?, 0)")
                .run(user_id, this.season.id, tick, at, act.sym, fraction, price);
            }
            this.savePosition(acc, act.sym, { qty: whole, avg });
          } else {
            // 상장폐지: 마지막 가격으로 전량 정산 (수수료 없음)
            acc.cash += pos.qty * act.price;
            this.db.prepare("INSERT INTO fills (user_id, season_id, tick, at, sym, side, qty, price, fee) VALUES (?, ?, ?, ?, ?, 'delist', ?, ?, 0)")
              .run(user_id, this.season.id, tick, at, act.sym, pos.qty, act.price);
            this.savePosition(acc, act.sym, { qty: 0, avg: 0 });
          }
          this.db.prepare("UPDATE accounts SET cash = ? WHERE user_id = ? AND season_id = ?").run(acc.cash, user_id, this.season.id);
        }
      });
    }
    return [...touched];
  }

  // ---------- 랭킹 ----------
  /** 총자산 순. 같으면 100배를 먼저 달성한 사람이 위. 100배 달성 시점도 여기서 기록한다 */
  get players() { return this.accounts.size; }

  ranking(limit = 50): RankRow[] {
    const rows = [...this.accounts.values()].map(acc => {
      const equity = this.equity(acc);
      if (equity >= GOAL && acc.clearedTick == null) {
        acc.clearedTick = this.market.tick;
        this.db.prepare("UPDATE accounts SET cleared_tick = ? WHERE user_id = ? AND season_id = ?").run(acc.clearedTick, acc.userId, this.season.id);
      }
      return { name: acc.name, equity, returnPct: (equity / START_CASH - 1) * 100, clearedTick: acc.clearedTick };
    });
    rows.sort((a, b) => b.equity - a.equity || (a.clearedTick ?? Infinity) - (b.clearedTick ?? Infinity));
    return rows.slice(0, limit).map((r, i) => ({ rank: i + 1, ...r }));
  }
}
