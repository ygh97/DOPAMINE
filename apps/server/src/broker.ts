// 계좌·현물·선물 주문·정산·랭킹. 주문은 호가창(Exchange)에서 즉시 체결된다 (M8).
// GameLoop는 tick마다 endTick() → exchange.step() → refundCancelled() → settleTrades() → applyActions() → runTriggers() 순서로 부른다.
//
// 체결 규칙 (SPEC 3장, docs/M8-호가창-설계.md):
// - 시장가는 호가를 먹으며 바로 체결된다. 수수료 0.05%. 슬리피지는 없다(스프레드·호가 두께가 대신한다).
// - 지정가는 맞는 호가가 있으면 그만큼 바로 체결(시장가 수수료)하고, 남은 수량은 호가창에 건다(체결 때 수수료 0).
//   걸어 둔 동안 필요한 돈·수량은 묶어 둔다. 1인 최대 20개, 시즌 끝까지 유효.
// - 현물: 매수는 예수금의 pct%, 매도는 보유 수량의 pct%. 종목당 보유 한도는 가상 유동성 L의 20%.
// - 선물: 격리 증거금 = 예수금의 pct% (진입 수수료 포함). 명목 = 증거금 × 레버리지.
//   증거금의 90%를 잃는 가격에서 강제 청산. 강제 청산·스탑·익절은 가격이 움직일 때마다 바로 시장가로 나간다 (연쇄 가능).
import { LEVERAGE, MAKER, qtyUnit, type CorporateAction, type Exchange, type Market, type MarketKind, type Side, type Trade } from "@dopamine/engine";
import { tx, type Db } from "./db.ts";
import type { Season } from "./season.ts";

export const START_CASH = 100_000;
export const MM_CASH = 2_000_000; // 🏦 세력·🐋 고래 계정 시작 자금
export const GRAD = 2_000_000;    // 20배 = 졸업
export const GOAL = 10_000_000;   // 100배 = 전설 (명예의 전당)
const FEE = 0.0005;              // 시장가(호가를 먹는 쪽) 수수료. 지정가로 걸어 둔 쪽은 0
const MAX_OPEN_ORDERS = 20;      // 1인 미체결 지정가 최대
const MAX_CASCADE = 50;          // 한 번에 이어서 처리하는 강제 청산·스탑 최대 건수
const HOLD_SHARE = 0.2;
const ORDERS_PER_TICK = 2;      // tick(1초)당 계정별 주문 수
const LIQ_LOSS = 0.9;           // 증거금 손실 90%에서 강제 청산
const RESET_LOCK_TICKS = 600;   // 다시 시작한 뒤 10분간 5배 초과 레버리지 금지
const RESET_MAX_LEV = 5;

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
  /** clearedTick: 100배 전설이 된 tick (100배 아래로 내려가면 null), gradTick: 20배 졸업 달성 tick */
  clearedTick: number | null; gradTick: number | null; resetAt: number | null;
  /** 🤖 봇 교대로 쉬는 중: 매매하지 않고 랭킹에서 숨는다 (메모리만) */
  resting?: boolean;
}
const startCash = (kind: AccountKind) => (kind === "mm" || kind === "whale" ? MM_CASH : START_CASH);
export interface Fill { id: number; tick: number; at: number; sym: string; side: string; qty: number; price: number; fee: number; pnl?: number }
/**
 * 걸어 둔 지정가 하나 (거래소 주문 id = id). qty = 남은 수량.
 * cash = 묶어 둔 돈 (현물 매수 대금, 선물 증거금+수수료), held/avg = 현물 매도로 보유에서 떼어 둔 수량과 그 평단.
 * posId = 선물 지정가가 체결되며 만든 포지션 (같은 주문의 체결은 한 포지션으로 모은다)
 */
interface Intent {
  id: number; userId: number; sym: string; kind: "spot" | "fut"; side: Side; lev: number; price: number; qty: number;
  cash: number; held: number; avg: number; posId: number | null; seq: number; filled?: number;
}
export interface RankRow { rank: number; name: string; kind: AccountKind; equity: number; returnPct: number; clearedTick: number | null; gradTick: number | null }
/** 세력 전략이 보는 종목별 쏠림: 사람·봇의 현물 평가액, 선물 롱·숏 명목, 청산가 목록 */
export interface Exposure { spot: number; long: number; short: number; liqs: { price: number; notional: number; side: "long" | "short" }[] }

/** 주식·신흥주는 1주 단위, 코인은 0.000001 단위 (현물·선물·호가 모두). 그래야 체결 수량이 늘 단위의 배수다 */
const step = qtyUnit;
const floorTo = (v: number, s: number) => Math.floor(v / s + 1e-9) * s;
const dirOf = (f: Future) => (f.side === "long" ? 1 : -1);
/** 강제 청산 가격: 증거금의 90%를 잃는 지점 */
export const liqPrice = (f: Pick<Future, "side" | "lev" | "entry">) => f.entry * (1 - (f.side === "long" ? 1 : -1) * LIQ_LOSS / f.lev);
const pnlOf = (f: Future, price: number, qty = f.qty) => dirOf(f) * qty * (price - f.entry);

export class Broker {
  private db: Db;
  private season: Season;
  private x: Exchange;
  private market: Market;
  private accounts = new Map<number, Account>();
  private intents = new Map<number, Intent>();          // 걸어 둔 지정가 (거래소 주문 id → 내용)
  private tickFlows = new Map<string, number>();        // 이번 tick 종목별 순매수 (시장가 쪽, 엔진에 남기고 재생용으로 기록)
  private crowdFlows = new Map<string, number>();       // 그중 세력 계정을 뺀 것
  private autoClosed: { type: string; sym: string }[] = [];
  private makerTouched = new Set<string>(); // 지정가가 체결된 종목
  private stuck = new Set<Future>();                    // 호가가 없어 이번 tick 청산하지 못한 포지션
  private broadcasts: string[] = [];
  private legendAnnounced = new Set<number>();           // 이번 시즌 [전설] 전광판 알림을 이미 띄운 사람
  private recent = new Map<number, { tick: number; count: number }>(); // 주문 속도 제한
  private rankCache: { tick: number; rows: RankRow[]; mm: RankRow[]; whales: RankRow[]; rankByUser: Map<string, number> } | null = null;
  /** 직전 정산의 종목별 순매수 명목 (세력 계정 주문 제외). 유동성 공급 세력이 반대편을 받는 데 쓴다 */
  lastFlows = new Map<string, number>();
  private stmts;

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
      upsertOrder: db.prepare("INSERT INTO open_orders (id, user_id, season_id, sym, kind, side, lev, price, qty, cash, held, avg, pos_id, seq, filled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET qty = excluded.qty, cash = excluded.cash, held = excluded.held, pos_id = excluded.pos_id, filled = excluded.filled"),
      delOrder: db.prepare("DELETE FROM open_orders WHERE id = ?"),
      selOrders: db.prepare('SELECT id, user_id AS "userId", sym, kind, side, lev, price, qty, cash, held, avg, pos_id, seq, filled FROM open_orders WHERE season_id = ? ORDER BY seq'),
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

  private price(sym: string) { return this.x.price(sym); }
  /** 선물 평가액: 증거금 + 미실현 손익 (0 아래로는 안 내려감, 격리) */
  private futureValue(f: Future) { return Math.max(0, f.margin + pnlOf(f, this.price(f.sym))); }

  equity(acc: Account): number {
    let v = acc.cash;
    for (const [sym, p] of acc.positions) v += p.qty * this.price(sym);
    for (const f of acc.futures.values()) v += this.futureValue(f);
    for (const it of this.intents.values()) if (it.userId === acc.userId) v += it.cash + it.held * this.price(it.sym); // 묶어 둔 돈·수량
    return v;
  }

  /** 이번 시즌(다시 시작한 뒤) 한 종목의 내 체결 전부: 차트 B/S 표시용 */
  fillsFor(userId: number, sym: string): Fill[] {
    return this.stmts.selSymFills.all(userId, this.season.id, sym, this.account(userId).resetAt ?? 0) as unknown as Fill[];
  }

  me(userId: number) {
    const acc = this.account(userId);
    const fills = this.stmts.selFills.all(userId, this.season.id, acc.resetAt ?? 0) as unknown as Fill[];
    const equity = this.equity(acc);
    this.ensureRankCache();
    return {
      name: acc.name, cash: acc.cash, equity, returnPct: (equity / startCash(acc.kind) - 1) * 100, goal: GOAL, grad: GRAD,
      clearedTick: acc.clearedTick, gradTick: acc.gradTick, resetAt: acc.resetAt, tick: this.market.tick,
      positions: [...acc.positions].map(([sym, p]) => ({ sym, qty: p.qty, avg: p.avg })),
      futures: [...acc.futures.values()].map(f => ({ id: f.id, sym: f.sym, side: f.side, lev: f.lev, qty: f.qty, entry: f.entry, margin: f.margin, stop: f.stop, tp: f.tp, liq: liqPrice(f) })),
      fills, orders: this.ordersOf(userId), rank: this.rankCache?.rankByUser.get(acc.name) ?? null,
    };
  }

  /** 다른 트레이더의 포트폴리오(현물·선물 포지션·청산가·미실현 손익) 공개 조회 (청산 사냥용) */
  portfolioByName(rawName: string) {
    const target = String(rawName ?? "").trim().toLowerCase();
    const acc = [...this.accounts.values()].find(a => a.name.toLowerCase() === target);
    if (!acc) throw new OrderError("트레이더를 찾을 수 없습니다.");
    this.ensureRankCache();
    const equity = this.equity(acc);
    const positions = [...acc.positions].map(([sym, p]) => {
      const price = this.price(sym);
      const value = p.qty * price, cost = p.qty * p.avg;
      return { sym, qty: p.qty, avg: p.avg, price, value, pnl: value - cost, pnlPct: cost ? (value / cost - 1) * 100 : 0 };
    });
    const futures = [...acc.futures.values()].map(f => {
      const price = this.price(f.sym), liq = liqPrice(f);
      const pnl = pnlOf(f, price);
      const value = Math.max(0, f.margin + pnl);
      return { id: f.id, sym: f.sym, side: f.side, lev: f.lev, qty: f.qty, entry: f.entry, price, margin: f.margin, liq, value, pnl, pnlPct: f.margin ? (pnl / f.margin) * 100 : 0 };
    });
    return {
      name: acc.name,
      kind: acc.kind,
      rank: this.rankCache?.rankByUser.get(acc.name) ?? null,
      cash: acc.cash,
      equity,
      returnPct: (equity / startCash(acc.kind) - 1) * 100,
      clearedTick: acc.clearedTick,
      positions,
      futures,
    };
  }

  /** 채팅 "[공유]" 문구를 실제 계좌 값으로 만든다 (화면이 만든 숫자를 믿지 않는다) */
  shareText(userId: number, req: { type: "spot" | "fut" | "fill" | "summary"; sym?: string; id?: number }): string {
    const acc = this.account(userId);
    const money = (v: number) => "$" + (v >= 1000 ? v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v.toFixed(v < 1 ? 4 : 2));
    const pct = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
    const side = (s: "long" | "short") => (s === "long" ? "롱" : "숏");
    const futPct = (f: Future) => (f.margin ? (pnlOf(f, this.price(f.sym)) / f.margin) * 100 : 0);
    if (req.type === "spot") {
      const p = acc.positions.get(req.sym ?? "");
      if (!p) throw new OrderError("보유하지 않은 종목입니다.");
      const price = this.price(req.sym!);
      return `[공유] $${req.sym} 현물 평단 ${money(p.avg)} → 현재 ${money(price)} (${pct((price / p.avg - 1) * 100)})`;
    }
    if (req.type === "fut") {
      const f = acc.futures.get(req.id ?? -1);
      if (!f) throw new OrderError("선물 포지션을 찾을 수 없습니다.");
      return `[공유] $${f.sym} ${f.lev}x ${side(f.side)} 진입 ${money(f.entry)} → 현재 ${money(this.price(f.sym))} (${pct(futPct(f))})`;
    }
    if (req.type === "fill") {
      const f = this.stmts.selFill.get(req.id ?? -1, userId, this.season.id) as unknown as Fill | undefined;
      if (!f) throw new OrderError("체결 내역을 찾을 수 없습니다.");
      const SIDE: Record<string, string> = {
        buy: "매수", sell: "매도", "long-open": "롱 진입", "short-open": "숏 진입", "long-close": "롱 종료", "short-close": "숏 종료",
        liquidation: "강제 청산", stop: "스탑로스", tp: "익절", delist: "상장폐지 정산", "split-cash": "병합 단주 정산",
      };
      const spot = f.side === "buy" || f.side === "sell" || f.side === "split-cash";
      const coin = this.market.quote(f.sym)?.market === "coin";
      const qty = coin || !Number.isInteger(f.qty) ? String(+f.qty.toFixed(6)) : f.qty.toLocaleString();
      const pnl = f.pnl != null ? ` · 실현손익 ${f.pnl >= 0 ? "+" : "-"}${money(Math.abs(f.pnl))}` : "";
      return `[공유] $${f.sym} [${spot ? "현물" : f.side === "delist" ? "정산" : "선물"}] ${SIDE[f.side] ?? f.side} ${qty}${coin ? "" : "주"} @ ${money(f.price)}${pnl}`;
    }
    const equity = this.equity(acc);
    const f = acc.futures.values().next().value as Future | undefined;
    const p = acc.positions.entries().next().value as [string, Position] | undefined;
    const part = f ? ` · $${f.sym} ${f.lev}x ${side(f.side)} ${pct(futPct(f))}`
      : p ? ` · $${p[0]} 현물 ${pct((this.price(p[0]) / p[1].avg - 1) * 100)}` : "";
    return `[공유] 총자산 ${money(equity)} (${pct((equity / startCash(acc.kind) - 1) * 100)})${part}`;
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
    });
    acc.cash = startCash(acc.kind); acc.positions.clear(); acc.futures.clear(); acc.resetAt = this.market.tick;
    this.rankCache = null;
  }

  // ---------- 주문 (호가창에서 즉시 체결) ----------
  private admit(userId: number, sym: string): Account {
    if (!this.x.quote(sym)) throw new OrderError("거래할 수 없는 종목입니다.");
    const acc = this.account(userId);
    if (acc.kind === "mm") return acc; // 세력은 여러 종목을 한 tick에 다뤄서 속도 제한을 받지 않는다
    const r = this.recent.get(userId);
    const count = r && r.tick === this.market.tick ? r.count : 0;
    if (count >= ORDERS_PER_TICK) throw new OrderError("주문이 너무 빠릅니다. 잠시 후 다시 시도하세요.");
    this.recent.set(userId, { tick: this.market.tick, count: count + 1 });
    return acc;
  }
  private checkPct(pct: number) {
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new OrderError("비중은 0~100% 사이여야 합니다.");
  }
  private checkLev(userId: number, sym: string, lev: number) {
    const q = this.x.quote(sym);
    if (!q) throw new OrderError("거래할 수 없는 종목입니다.");
    if (!LEVERAGE[q.market].includes(lev)) throw new OrderError(`이 종목의 레버리지는 ${LEVERAGE[q.market].join("·")}배만 됩니다.`);
    const acc = this.account(userId);
    if (lev > RESET_MAX_LEV && acc.resetAt != null && this.market.tick - acc.resetAt < RESET_LOCK_TICKS)
      throw new OrderError(`다시 시작한 뒤 10분 동안은 ${RESET_MAX_LEV}배를 넘는 레버리지를 쓸 수 없습니다.`);
  }
  /** 한 번의 주문을 트랜잭션으로 묶는다. DB가 실패하면 메모리 계좌를 버리고 다시 읽는다 */
  private atomic<T>(userIds: number[], fn: () => T): T {
    try { return tx(this.db, fn); }
    catch (e) {
      if (e instanceof OrderError) throw e;
      for (const id of userIds) this.accounts.delete(id);
      console.error(e);
      throw new OrderError("주문 처리 중 오류가 났습니다. 보유종목을 확인하세요.");
    }
  }
  private record(acc: Account, sym: string, side: string, qty: number, price: number, fee: number, pnl?: number): Fill {
    const tick = this.market.tick, at = Date.now();
    this.stmts.updCash.run(acc.cash, acc.userId, this.season.id);
    const id = Number(this.stmts.insFill.run(acc.userId, this.season.id, tick, at, sym, side, qty, price, fee, pnl ?? null).lastInsertRowid);
    this.rankCache = null;
    return { id, tick, at, sym, side, qty, price, fee, pnl };
  }
  private vwap(trades: Trade[]) {
    let qty = 0, notional = 0;
    for (const t of trades) { qty += t.qty; notional += t.qty * t.price; }
    return { qty, notional, price: qty ? notional / qty : 0 };
  }
  /** 시장가 체결: 호가창을 먹고, 같이 체결된 지정가 주인(maker) 계좌도 반영하고, 순매수를 tick 흐름에 더한다 */
  private takeMarket(acc: Account, sym: string, side: Side, qty: number) {
    const trades = this.x.marketOrder(acc.userId, sym, side, { qty });
    this.settleTrades(trades);
    const v = this.vwap(trades);
    this.addFlow(acc, sym, side === "buy" ? v.notional : -v.notional);
    return v;
  }
  private addFlow(acc: Account, sym: string, signed: number) {
    if (!signed) return;
    this.tickFlows.set(sym, (this.tickFlows.get(sym) ?? 0) + signed);
    if (acc.kind !== "mm") this.crowdFlows.set(sym, (this.crowdFlows.get(sym) ?? 0) + signed);
  }

  /** 시장가 주문. 바로 체결된다 (Promise는 예전 API 호환). 잘못된 주문은 OrderError를 바로 던진다 */
  place(userId: number, sym: string, side: string, pct: number): Promise<Fill> {
    return Promise.resolve(this.placeNow(userId, sym, side, pct));
  }
  /** 현물 시장가. 매수는 예수금의 pct%, 매도는 보유 수량의 pct% */
  private placeNow(userId: number, sym: string, side: string, pct: number): Fill {
    if (side !== "buy" && side !== "sell") throw new OrderError("매수 또는 매도만 할 수 있습니다.");
    this.checkPct(pct);
    const acc = this.admit(userId, sym), q = this.x.quote(sym)!, unit = step(q.market);
    const pos = acc.positions.get(sym) ?? { qty: 0, avg: 0 };
    if (side === "sell" && !pos.qty) throw new OrderError("보유하지 않은 종목입니다.");
    const fill = this.atomic([userId], () => {
      if (side === "buy") {
        const L = this.x.market.liquidity(sym) ?? Infinity, ask = this.x.best(sym).ask ?? q.price;
        const room = floorTo((HOLD_SHARE * L) / ask - pos.qty, unit);
        if (room <= 0) throw new OrderError(`보유 한도(가상 유동성의 20%, 약 $${Math.round(HOLD_SHARE * L).toLocaleString()})에 도달했습니다.`);
        const budget = (acc.cash * pct) / 100 / (1 + FEE);
        const want = Math.min(floorTo(this.x.qtyFor(userId, sym, "buy", budget), unit), room);
        if (want <= 0) throw new OrderError("예수금이 부족해 1주도 살 수 없습니다.");
        const v = this.takeMarket(acc, sym, "buy", want);
        if (v.qty <= 0) throw new OrderError("호가가 없어 체결되지 않았습니다.");
        const fee = v.notional * FEE;
        acc.cash -= v.notional + fee;
        pos.avg = (pos.qty * pos.avg + v.notional + fee) / (pos.qty + v.qty); // 평단은 매수 수수료 포함
        pos.qty += v.qty;
        this.savePosition(acc, sym, pos);
        return this.record(acc, sym, "buy", v.qty, v.price, fee);
      }
      const want = pct >= 100 ? pos.qty : floorTo((pos.qty * pct) / 100, unit); // 전량은 남김 없이
      if (want <= 0) throw new OrderError("팔 수량이 없습니다.");
      const v = this.takeMarket(acc, sym, "sell", want);
      if (v.qty <= 0) throw new OrderError("호가가 없어 체결되지 않았습니다.");
      const fee = v.notional * FEE;
      acc.cash += v.notional - fee;
      pos.qty -= v.qty;
      this.savePosition(acc, sym, pos);
      return this.record(acc, sym, "sell", v.qty, v.price, fee, v.notional - v.qty * pos.avg - fee);
    });
    this.runTriggers(sym);
    return fill;
  }

  openFuture(userId: number, sym: string, side: string, lev: number, pct: number): Promise<Fill> {
    return Promise.resolve(this.openNow(userId, sym, side, lev, pct));
  }
  /** 선물 시장가 진입. 격리 증거금 = 예수금의 pct% (진입 수수료 포함), 명목 = 증거금 × 레버리지 */
  private openNow(userId: number, sym: string, side: string, lev: number, pct: number): Fill {
    if (side !== "long" && side !== "short") throw new OrderError("롱 또는 숏만 할 수 있습니다.");
    this.checkPct(pct);
    this.checkLev(userId, sym, lev);
    const acc = this.admit(userId, sym), xs: Side = side === "long" ? "buy" : "sell";
    const fill = this.atomic([userId], () => {
      const margin0 = (acc.cash * pct) / 100 / (1 + lev * FEE);
      if (margin0 < 1) throw new OrderError("예수금이 부족합니다.");
      const want = floorTo(this.x.qtyFor(userId, sym, xs, margin0 * lev), step(this.x.quote(sym)!.market));
      if (want <= 0) throw new OrderError("증거금이 부족해 1주도 진입할 수 없습니다.");
      const v = this.takeMarket(acc, sym, xs, want);
      if (v.qty <= 0) throw new OrderError("호가가 없어 체결되지 않았습니다.");
      const margin = v.notional / lev, fee = v.notional * FEE;
      acc.cash -= margin + fee;
      const f = this.newFuture(acc, sym, side, lev, v.qty, v.price, margin);
      return this.record(acc, sym, `${f.side}-open`, v.qty, v.price, fee);
    });
    this.runTriggers(sym);
    return fill;
  }
  /**
   * 선물 진입. 같은 종목·방향·배율 포지션이 있으면 거기에 합친다 (물타기·불타기): 수량·증거금은 더하고 진입가는 수량 가중 평균,
   * 청산가는 새 진입가로 다시 계산되고 익절·손절은 그대로. 배율이 다르면 청산가가 달라 따로 둔다
   */
  private newFuture(acc: Account, sym: string, side: "long" | "short", lev: number, qty: number, entry: number, margin: number): Future {
    for (const g of acc.futures.values()) {
      if (g.sym !== sym || g.side !== side || g.lev !== lev || g.closing) continue;
      g.entry = (g.entry * g.qty + entry * qty) / (g.qty + qty); g.qty += qty; g.margin += margin;
      this.stmts.updFutOpen.run(g.qty, g.entry, g.margin, g.id);
      return g;
    }
    const f: Future = { id: 0, sym, side, lev, qty, entry, margin, stop: null, tp: null, closing: false };
    f.id = Number(this.stmts.insFut.run(acc.userId, this.season.id, sym, side, lev, qty, entry, margin, this.market.tick).lastInsertRowid);
    acc.futures.set(f.id, f);
    return f;
  }

  closeFuture(userId: number, posId: number, pct: number): Promise<Fill> {
    this.checkPct(pct);
    const f = this.account(userId).futures.get(posId);
    if (!f) throw new OrderError("선물 포지션을 찾을 수 없습니다.");
    if (f.closing) throw new OrderError("이미 청산 중인 포지션입니다.");
    this.admit(userId, f.sym);
    const fill = this.closeNow(this.account(userId), f, pct, "user");
    this.runTriggers(f.sym);
    return Promise.resolve(fill);
  }
  /** 선물 종료 (사용자 / 강제 청산 / 스탑로스 / 익절). 반대 방향 시장가로 호가를 먹는다 */
  private closeNow(acc: Account, f: Future, pct: number, reason: "user" | "liquidation" | "stop" | "tp"): Fill {
    return this.atomic([acc.userId], () => {
      const share = Math.min(1, pct / 100);
      const qty = share >= 1 ? f.qty : floorTo(f.qty * share, step(this.x.quote(f.sym)?.market ?? "stock"));
      if (qty <= 0) throw new OrderError("종료할 수량이 1주보다 적습니다. 더 큰 비중으로 종료하세요.");
      const v = this.takeMarket(acc, f.sym, f.side === "long" ? "sell" : "buy", qty);
      if (v.qty <= 0) throw new OrderError("호가가 없어 체결되지 않았습니다.");
      const part = v.qty / f.qty, margin = f.margin * part, fee = v.notional * FEE;
      const pnl = pnlOf(f, v.price, v.qty);
      acc.cash += Math.max(0, margin + pnl - fee); // 격리: 증거금보다 더 잃지는 않는다
      if (part >= 1 - 1e-9) {
        acc.futures.delete(f.id);
        this.stmts.delFut.run(f.id);
      } else {
        f.qty -= v.qty; f.margin -= margin; // 스탑로스는 남은 포지션에 유지
        this.stmts.updFutPart.run(f.qty, f.margin, f.id);
      }
      if (reason === "liquidation")
        this.broadcasts.push(`[강제청산] 💥 ${acc.name}님 $${f.sym} ${f.lev}x ${f.side === "long" ? "롱" : "숏"} (증거금 $${Math.round(f.margin).toLocaleString()}) 강제청산!`);
      if (reason !== "user") this.autoClosed.push({ type: reason, sym: f.sym });
      const side = reason === "user" ? `${f.side}-close` : reason;
      return this.record(acc, f.sym, side, v.qty, v.price, fee, pnl);
    });
  }

  /** 보유 현물·선물 포지션 일괄 100% 시장가 매도·종료 */
  closeAll(userId: number, scope: "spot" | "futures" | "all" = "all"): Promise<Fill[]> {
    {
      const acc = this.account(userId);
      const r = this.recent.get(userId);
      const count = r && r.tick === this.market.tick ? r.count : 0;
      if (count >= ORDERS_PER_TICK) throw new OrderError("주문이 너무 빠릅니다. 잠시 후 다시 시도하세요.");
      const fills: Fill[] = [];
      if (scope === "spot" || scope === "all")
        for (const [sym, p] of [...acc.positions]) {
          if (p.qty <= 0 || !this.x.quote(sym)) continue;
          this.recent.delete(userId); // 일괄 정리는 한 번의 주문으로 센다
          fills.push(this.placeNow(userId, sym, "sell", 100));
        }
      if (scope === "futures" || scope === "all")
        for (const f of [...acc.futures.values()]) if (!f.closing && this.x.quote(f.sym)) { fills.push(this.closeNow(acc, f, 100, "user")); this.runTriggers(f.sym); }
      if (!fills.length) throw new OrderError("정리할 보유종목이나 선물 포지션이 없습니다.");
      this.recent.set(userId, { tick: this.market.tick, count: count + 1 });
      return Promise.resolve(fills);
    }
  }

  // ---------- 지정가 ----------
  /**
   * 지정가 주문. 맞는 호가가 있으면 그만큼 바로 체결(시장가 수수료)하고, 남은 수량은 호가창에 건다(수수료 0).
   * 걸어 둔 동안 필요한 돈(또는 보유 수량)은 묶어 둔다. 체결·취소되면 풀린다.
   * - spot buy: 예수금의 pct%로 살 수 있는 수량, spot sell: 보유 수량의 pct%
   * - fut buy/sell (= 롱/숏 진입): 증거금 = 예수금의 pct%, 명목 = 증거금 × 레버리지
   */
  limitOrder(userId: number, req: { sym: string; kind: "spot" | "fut"; side: Side; price: number; pct: number; lev?: number }) {
    const { sym, kind, side, pct } = req;
    if (side !== "buy" && side !== "sell") throw new OrderError("매수 또는 매도만 할 수 있습니다.");
    if (!Number.isFinite(req.price) || req.price <= 0) throw new OrderError("가격이 올바르지 않습니다.");
    this.checkPct(pct);
    if (kind === "fut") this.checkLev(userId, sym, req.lev ?? 0);
    const acc = this.admit(userId, sym), q = this.x.quote(sym)!, unit = step(q.market);
    if (this.ordersOf(userId).length >= MAX_OPEN_ORDERS) throw new OrderError(`미체결 주문은 최대 ${MAX_OPEN_ORDERS}개입니다.`);
    const tickSz = this.x.tickOf(sym), price = Math.max(tickSz, Math.round(req.price / tickSz) * tickSz);
    const out = this.atomic([userId], () => {
      const it: Intent = { id: 0, userId, sym, kind, side, lev: req.lev ?? 1, price, qty: 0, cash: 0, held: 0, avg: 0, posId: null, seq: 0 };
      if (kind === "spot" && side === "buy") {
        const L = this.x.market.liquidity(sym) ?? Infinity, have = acc.positions.get(sym)?.qty ?? 0;
        const room = floorTo((HOLD_SHARE * L) / price - have, unit);
        it.qty = Math.min(floorTo((acc.cash * pct) / 100 / (price * (1 + FEE)), unit), room);
        if (it.qty <= 0) throw new OrderError(room <= 0 ? "보유 한도에 도달했습니다." : "예수금이 부족합니다.");
        it.cash = it.qty * price * (1 + FEE); acc.cash -= it.cash; // 바로 체결될 몫의 수수료까지 묶는다
      } else if (kind === "spot") {
        const pos = acc.positions.get(sym);
        if (!pos?.qty) throw new OrderError("보유하지 않은 종목입니다.");
        it.qty = pct >= 100 ? pos.qty : floorTo((pos.qty * pct) / 100, unit);
        if (it.qty <= 0) throw new OrderError("팔 수량이 없습니다.");
        it.held = it.qty; it.avg = pos.avg; pos.qty -= it.qty; this.savePosition(acc, sym, pos); // 파는 수량을 보유에서 떼어 둔다
      } else {
        const budget = (acc.cash * pct) / 100 / (1 + it.lev * FEE);
        it.qty = floorTo((budget * it.lev) / price, step(q.market));
        if (it.qty <= 0) throw new OrderError("증거금이 부족해 1주도 진입할 수 없습니다.");
        it.cash = ((it.qty * price) / it.lev) * (1 + it.lev * FEE); acc.cash -= it.cash; // 증거금 + 바로 체결될 몫의 수수료
      }
      this.stmts.updCash.run(acc.cash, acc.userId, this.season.id);
      const res = this.x.limitOrder(userId, sym, side, price, it.qty);
      // 바로 체결된 몫: 시장가처럼 수수료를 내고 계좌에 반영
      const fills: Fill[] = [];
      if (res.trades.length) {
        this.settleTrades(res.trades);
        const v = this.vwap(res.trades);
        this.addFlow(acc, sym, side === "buy" ? v.notional : -v.notional);
        fills.push(this.fillIntent(acc, it, v.qty, v.price, true));
      }
      if (res.order) {
        it.id = res.order.id; it.seq = res.order.seq; it.qty = res.order.qty;
        this.intents.set(it.id, it);
        this.saveIntent(it);
      } else this.release(acc, it);
      return { fills, order: res.order ? this.orderView(it) : null };
    });
    this.runTriggers(sym);
    return out;
  }

  /** 걸어 둔 지정가 취소. 묶어 둔 돈·수량을 돌려준다 */
  cancelOrder(userId: number, orderId: number) {
    const it = this.intents.get(orderId);
    if (!it || it.userId !== userId) throw new OrderError("미체결 주문을 찾을 수 없습니다.");
    const r = this.recent.get(userId), count = r && r.tick === this.market.tick ? r.count : 0;
    if (count >= ORDERS_PER_TICK && this.account(userId).kind !== "mm") throw new OrderError("주문이 너무 빠릅니다. 잠시 후 다시 시도하세요.");
    this.recent.set(userId, { tick: this.market.tick, count: count + 1 });
    this.x.cancel(userId, orderId);
    this.atomic([userId], () => this.release(this.account(userId), it));
  }
  /** 내 미체결 지정가 전체 취소 (한 번의 주문으로 센다). 취소한 개수를 돌려준다 */
  cancelAll(userId: number) {
    const mine = [...this.intents.values()].filter(it => it.userId === userId);
    if (!mine.length) throw new OrderError("취소할 미체결 주문이 없습니다.");
    const r = this.recent.get(userId), count = r && r.tick === this.market.tick ? r.count : 0;
    if (count >= ORDERS_PER_TICK && this.account(userId).kind !== "mm") throw new OrderError("주문이 너무 빠릅니다. 잠시 후 다시 시도하세요.");
    this.recent.set(userId, { tick: this.market.tick, count: count + 1 });
    const acc = this.account(userId);
    this.atomic([userId], () => { for (const it of mine) { this.x.cancel(userId, it.id); this.release(acc, it); } });
    return mine.length;
  }
  ordersOf(userId: number) { return [...this.intents.values()].filter(it => it.userId === userId).map(it => this.orderView(it)); }
  private orderView(it: Intent) {
    // cash = 묶어 둔 돈, held = 현물 매도로 떼어 둔 수량 (화면이 총자산에 더한다)
    return { id: it.id, sym: it.sym, kind: it.kind, side: it.side, lev: it.lev, price: it.price, qty: it.qty, filled: it.filled ?? 0, cash: it.cash, held: it.held };
  }

  /**
   * 거래소가 돌려준 체결 중 걸어 둔 지정가(maker)가 사람·봇 것이면 그 계좌에 반영한다 (수수료 0).
   * GameLoop도 exchange.step()이 돌려준 체결(가격이 지나간 지정가를 호가 봇이 받은 것)을 여기로 넘긴다
   */
  settleTrades(trades: Trade[]) {
    for (const t of trades) {
      if (t.maker === MAKER) continue;
      const it = this.intents.get(t.makerOrder);
      if (!it) continue;
      const acc = this.account(it.userId);
      this.fillIntent(acc, it, t.qty, t.price, false);
      if (it.qty <= 1e-9) this.release(acc, it); else this.saveIntent(it);
      this.addFlow(acc, t.sym, 0); // maker는 흐름을 만들지 않는다 (taker 쪽에서 센다)
      this.makerTouched.add(it.sym);
    }
  }
  /** 지정가 주문의 일부(qty)가 price에 체결됨. taker = 걸자마자 바로 체결된 몫 (수수료 냄) */
  private fillIntent(acc: Account, it: Intent, qty: number, price: number, taker: boolean): Fill {
    const notional = qty * price, fee = taker ? notional * FEE : 0;
    it.qty -= qty; it.filled = (it.filled ?? 0) + qty;
    if (it.kind === "spot" && it.side === "buy") {
      it.cash -= notional + fee;
      const pos = acc.positions.get(it.sym) ?? { qty: 0, avg: 0 };
      pos.avg = (pos.qty * pos.avg + notional + fee) / (pos.qty + qty);
      pos.qty += qty;
      this.savePosition(acc, it.sym, pos);
      return this.record(acc, it.sym, "buy", qty, price, fee);
    }
    if (it.kind === "spot") {
      it.held -= qty;
      acc.cash += notional - fee;
      return this.record(acc, it.sym, "sell", qty, price, fee, notional - qty * it.avg - fee);
    }
    const margin = notional / it.lev, side = it.side === "buy" ? "long" : "short";
    it.cash -= margin + fee;
    const f = this.newFuture(acc, it.sym, side, it.lev, qty, price, margin); // 같은 종목·방향·배율이면 합쳐진다
    it.posId = f.id;
    return this.record(acc, it.sym, `${side}-open`, qty, price, fee);
  }
  /** 주문이 끝나거나 취소됨: 남은 묶음을 돌려주고 지운다 */
  private release(acc: Account, it: Intent) {
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
  private saveIntent(it: Intent) {
    this.stmts.upsertOrder.run(it.id, it.userId, this.season.id, it.sym, it.kind, it.side, it.lev, it.price, it.qty, it.cash, it.held, it.avg, it.posId, it.seq, it.filled ?? 0);
  }
  /** 재시작: DB에 남은 지정가를 거래소에 다시 건다 */
  restoreOrders() {
    this.x.clearPeopleOrders();
    for (const r of this.stmts.selOrders.all(this.season.id) as unknown as (Intent & { pos_id: number | null })[]) {
      const it: Intent = { ...r, posId: r.pos_id };
      if (!this.x.restoreOrder({ id: it.id, owner: it.userId, sym: it.sym, side: it.side, price: it.price, qty: it.qty, seq: it.seq })) {
        this.account(it.userId); this.release(this.account(it.userId), it); continue; // 폐지된 종목이면 돌려준다
      }
      this.intents.set(it.id, it);
      this.account(it.userId);
    }
  }
  /** 병합·폐지로 거래소가 취소한 주문을 돌려준다 */
  refundCancelled(orders: { id: number }[]) {
    for (const o of orders) { const it = this.intents.get(o.id); if (it) this.release(this.account(it.userId), it); }
  }

  // ---------- 스탑·익절·강제 청산 ----------
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

  /**
   * 가격이 움직일 때마다(체결 직후, tick마다) 강제 청산·스탑·익절을 바로 처리한다.
   * 청산 매도가 다시 가격을 밀면 다음 청산이 이어질 수 있다 (연쇄). 무한 연쇄를 막으려고 한 번에 최대 MAX_CASCADE건
   */
  runTriggers(sym?: string) {
    for (let n = 0; n < MAX_CASCADE; n++) {
      let hit: { acc: Account; f: Future; reason: "liquidation" | "stop" | "tp" } | null = null;
      for (const acc of this.accounts.values()) {
        for (const f of acc.futures.values()) {
          if (f.closing || (sym && f.sym !== sym)) continue;
          const p = this.price(f.sym), long = f.side === "long";
          if (long ? p <= liqPrice(f) : p >= liqPrice(f)) { hit = { acc, f, reason: "liquidation" }; break; }
          if (f.stop != null && (long ? p <= f.stop : p >= f.stop)) { hit = { acc, f, reason: "stop" }; break; }
          if (f.tp != null && (long ? p >= f.tp : p <= f.tp)) { hit = { acc, f, reason: "tp" }; break; }
        }
        if (hit) break;
      }
      if (!hit) return;
      try { this.closeNow(hit.acc, hit.f, 100, hit.reason); }
      catch { hit.f.closing = true; this.stuck.add(hit.f); } // 호가가 없으면 이번 tick은 건너뛰고 다음 tick에 다시
    }
  }

  // ---------- tick 경계 ----------
  /**
   * tick이 끝날 때(다음 step() 전) 부른다. 이번 tick 순매수를 엔진 기준가에 남기고(영구 몫), 재시작 재생용으로 기록한다.
   * 재생 때도 같은 순서로 absorbFlow를 부르므로 기준가 경로가 같다
   */
  endTick() {
    const tick = this.market.tick;
    if (this.tickFlows.size) tx(this.db, () => {
      for (const [sym, net] of this.tickFlows) {
        if (!net) continue;
        this.stmts.insFlow.run(this.season.id, tick, sym, net);
        this.x.market.absorbFlow(sym, net);
      }
    });
    this.lastFlows = this.crowdFlows;
    this.tickFlows = new Map(); this.crowdFlows = new Map();
    for (const f of this.stuck) f.closing = false;
    this.stuck.clear();
  }
  /** 이번 interval 동안 자동으로 종료된 포지션 (강제 청산·스탑·익절)과 지정가가 체결된 사람 → 화면이 계좌를 다시 받게 */
  drainAuto() {
    const out = { closed: this.autoClosed, makers: [...this.makerTouched] };
    this.autoClosed = []; this.makerTouched.clear();
    return out;
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
    const money = (v: number) => `$${Math.round(v).toLocaleString()}`;
    const raw = [...this.accounts.values()].filter(acc => !acc.resting).map(acc => {
      const equity = this.equity(acc);
      // 20배 졸업·100배 전설은 사람과 봇만 (봇은 졸업률 확인용으로 기록만, 전광판 알림은 사람만)
      if (acc.kind === "user" || acc.kind === "bot") {
        const tick = this.market.tick, loud = acc.kind === "user";
        if (equity >= GRAD && acc.gradTick == null) {
          acc.gradTick = tick;
          this.stmts.updGrad.run(tick, acc.userId, this.season.id);
          if (loud) this.broadcasts.push(`[졸업] 🎓 ${acc.name}님이 총자산 ${money(equity)} 달성으로 20배 졸업!`);
        }
        // 전설은 100배를 유지하는 동안만: 아래로 내려가면 지워지고, 시즌 끝에 100배 이상인 사람만 명예의 전당에 남는다.
        // 전광판 알림은 시즌에 사람마다 한 번 (기준선 근처에서 오르내릴 때 반복하지 않게)
        if (equity >= GOAL && acc.clearedTick == null) {
          acc.clearedTick = tick;
          this.stmts.updCleared.run(tick, acc.userId, this.season.id);
          if (loud && !this.legendAnnounced.has(acc.userId)) {
            this.legendAnnounced.add(acc.userId);
            this.broadcasts.push(`[전설] 🏆 ${acc.name}님이 총자산 ${money(equity)} 달성으로 100배 전설이 되었습니다!`);
          }
        } else if (equity < GOAL && acc.clearedTick != null) {
          acc.clearedTick = null;
          this.stmts.updCleared.run(null, acc.userId, this.season.id);
        }
      }
      return { name: acc.name, kind: acc.kind, equity, returnPct: (equity / startCash(acc.kind) - 1) * 100, clearedTick: acc.clearedTick, gradTick: acc.gradTick };
    });
    const order = (a: { equity: number; clearedTick: number | null }, b: { equity: number; clearedTick: number | null }) =>
      b.equity - a.equity || (a.clearedTick ?? Infinity) - (b.clearedTick ?? Infinity);
    const byReturn = (a: { returnPct: number }, b: { returnPct: number }) => b.returnPct - a.returnPct;
    // 세력·고래는 자금 규모가 달라 같은 줄에 세우지 않는다. 각자 탭에서 수익률 순
    const ranked = (rs: typeof raw) => rs.map((r, i) => ({ rank: i + 1, ...r }));
    const rows = ranked(raw.filter(r => r.kind === "user" || r.kind === "bot").sort(order));
    const mm = ranked(raw.filter(r => r.kind === "mm").sort(byReturn));
    const whales = ranked(raw.filter(r => r.kind === "whale").sort(byReturn));
    const rankByUser = new Map<string, number>();
    for (const r of rows) rankByUser.set(r.name, r.rank);
    this.rankCache = { tick: this.market.tick, rows, mm, whales, rankByUser };
    return this.rankCache;
  }

  /** 총자산 순(사람 + 🤖 봇, 쉬는 봇 제외). 같으면 100배를 먼저 달성한 사람이 위. 졸업·전설 시점도 여기서 기록한다 */
  ranking(limit = 50): RankRow[] {
    return this.ensureRankCache().rows.slice(0, limit);
  }
  /** 🏦 세력 계정 (수익률 순) */
  mmRanking(): RankRow[] {
    return this.ensureRankCache().mm;
  }
  /** 🐋 고래 (수익률 순, 별도 탭) */
  whaleRanking(): RankRow[] {
    return this.ensureRankCache().whales;
  }
  /** 계정 종류가 바뀌었을 때 (예: 세력이던 고래 → 고래). 이미 메모리에 올라간 계좌도 맞춘다 */
  /** 계정 이름이 바뀌었을 때 (예: 예전 세력 이름 → 세력1). 이미 메모리에 올라간 계좌도 맞춘다 */
  setName(userId: number, name: string) {
    if (this.accounts.has(userId)) this.account(userId).name = name;
    this.rankCache = null;
  }
  setKind(userId: number, kind: AccountKind) {
    this.account(userId).kind = kind;
    this.rankCache = null;
  }
  /** 🤖 봇 교대: 쉬게 하거나 깨운다. 쉬는 봇은 랭킹에서 숨는다 */
  setResting(userId: number, resting: boolean) {
    this.account(userId).resting = resting;
    this.rankCache = null;
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
