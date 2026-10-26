// 계좌·현물·선물 주문·정산·랭킹. 주문은 호가창(Exchange)에서 즉시 체결된다 (M8).
// GameLoop는 tick마다 endTick() → exchange.step() → refundCancelled() → settleTrades() → applyActions() → runTriggers() 순서로 부른다.
//
// 체결 규칙 (SPEC 3장, docs/M8-호가창-설계.md):
// - 시장가는 호가를 먹으며 바로 체결된다. 수수료 0.05%. 슬리피지는 없다(스프레드·호가 두께가 대신한다).
// - 지정가는 맞는 호가가 있으면 그만큼 바로 체결(시장가 수수료)하고, 남은 수량은 호가창에 건다(체결 때 수수료 0).
//   걸어 둔 동안 필요한 돈·수량은 묶어 둔다. 1인 최대 20개, 시즌 끝까지 유효.
// - 현물: 매수는 예수금의 pct%, 매도는 보유 수량의 pct%. 종목당 보유 한도는 없다 (2026-10-25 전: 가상 유동성 L의 20%). 큰 주문은 호가창을 먹으며 비싸진다.
// - 선물: 격리 증거금 = 예수금의 pct% (진입 수수료 포함). 명목 = 증거금 × 레버리지.
//   증거금의 90%를 잃는 가격에서 강제 청산. 강제 청산·스탑·익절은 가격이 움직일 때마다 바로 시장가로 나간다 (연쇄 가능).
//
// 파일 나눔 (2026-10-27): broker/core.ts(계좌·기록) → broker/positions.ts(체결·포지션·자동 종료) → broker/orders.ts(주문 접수) → 이 파일(랭킹·조회·tick 경계·상장 변화·그리기).
// 다른 파일은 예전처럼 이 파일에서 import한다.
import { tx } from "./db.ts";
import type { CorporateAction } from "@dopamine/engine";
import { BrokerOrders } from "./broker/orders.ts";
import { CROWD_TICKS, GOAL, GRAD, MM_CASH, OrderError, START_CASH, WHALE_CASH, liqPrice, pnlOf, startCash, type Account, type AccountKind, type Exposure, type Fill, type Future, type Position, type RankRow } from "./broker/core.ts";

export { CROWD_TICKS, GOAL, GRAD, MM_CASH, OrderError, START_CASH, WHALE_CASH, liqPrice, startCash };
export type { Account, AccountKind, Exposure, Fill, Future, Position, RankRow };

export class Broker extends BrokerOrders {
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
    let old = 0; // 단합 감지 구간 밖으로 나간 기록을 버린다
    while (old < this.humanFlows.length && this.humanFlows[old].tick <= tick - CROWD_TICKS) old++;
    if (old) this.humanFlows.splice(0, old);
    for (const f of this.stuck) f.closing = false;
    this.stuck.clear();
  }
  /** 이번 interval 동안 자동으로 종료된 포지션 (강제 청산·스탑·익절)과 지정가가 체결된 사람 → 화면이 계좌를 다시 받게 */
  drainAuto() {
    const out = { closed: this.autoClosed, makers: [...this.makerTouched] };
    this.autoClosed = []; this.makerTouched.clear();
    return out;
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
      // 50배 졸업·100배 전설은 사람과 봇만 (봇은 졸업률 확인용으로 기록만, 전광판 알림은 사람만)
      if (acc.kind === "user" || acc.kind === "bot") {
        const tick = this.market.tick, loud = acc.kind === "user";
        if (equity >= GRAD && acc.gradTick == null) {
          acc.gradTick = tick;
          this.stmts.updGrad.run(tick, acc.userId, this.season.id);
          if (loud) this.broadcasts.push(`[졸업] 🎓 ${acc.name}님이 총자산 ${money(equity)} 달성으로 50배 졸업!`);
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
    // 화면 랭킹은 사람끼리, 🤖 봇은 따로 (2026-10-24). 순위 숫자(내 순위·포지션 스캔)도 각자 안에서
    const rerank = (rs: RankRow[]) => rs.map((r, i) => ({ ...r, rank: i + 1 }));
    const people = rerank(rows.filter(r => r.kind === "user")), bots = rerank(rows.filter(r => r.kind === "bot"));
    const rankByUser = new Map<string, number>();
    for (const r of [...people, ...bots]) rankByUser.set(r.name, r.rank);
    this.rankCache = { tick: this.market.tick, rows, people, bots, mm, whales, rankByUser };
    return this.rankCache;
  }

  /** 총자산 순(사람 + 🤖 봇, 쉬는 봇 제외). 같으면 100배를 먼저 달성한 사람이 위. 졸업·전설 시점도 여기서 기록한다 */
  ranking(limit = 50): RankRow[] {
    return this.ensureRankCache().rows.slice(0, limit);
  }
  /** 화면 랭킹: 사람만 (총자산 순, 사람끼리 순위) */
  peopleRanking(limit = 50): RankRow[] {
    return this.ensureRankCache().people.slice(0, limit);
  }
  /** 🤖 봇 탭: 봇만 (총자산 순, 쉬는 봇 제외) */
  botRanking(limit = 50): RankRow[] {
    return this.ensureRankCache().bots.slice(0, limit);
  }
  /** 화면에 보이는 사람·봇 수 */
  get counts() { const c = this.ensureRankCache(); return { people: c.people.length, bots: c.bots.length }; }
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
