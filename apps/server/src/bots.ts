// 🤖 봇과 🏦 세력 계정. 사람과 같은 Broker 주문 경로(호가창 체결·수수료·속도 제한·강제 청산)로 매매한다.
// M8부터 엔진의 숨은 패턴(개미털기·스퀴즈·설거지·가짜 돌파)은 꺼져 있고, 그 몫을 세력 계좌가 실제 주문으로 한다 (A13).
// 적정가로 당기는 힘도 가치투자 세력(공매도·저평가 매수)이 맡는다. 엔진의 당김은 안전장치만큼 (A14).
// 서버는 BOTS·MARKET_MAKERS 환경 변수로 켜고, tools/sim-bots.ts는 같은 코드로 졸업률을 잰다.
// 결정은 계좌별 seed 난수로만 한다 (Math.random 금지) → 같은 seed면 같은 결과.
import { ASSETS, LEVERAGE, type NewsItem, type Quote } from "@dopamine/engine";

/** 봇이 보는 시장: 호가창(Exchange)의 체결가·유동성 */
export interface MarketView { readonly tick: number; quotes(): Quote[]; quote(sym: string): Quote | null; liquidity(sym: string): number | null; best(sym: string): { bid: number | null; ask: number | null } }
type Market = MarketView;
import type { AccountKind, Broker } from "./broker.ts";
import type { Db } from "./db.ts";

function mulberry32(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rand = () => number;
const uni = (r: Rand, a: number, b: number) => a + (b - a) * r();
const pick = <T>(r: Rand, arr: readonly T[]): T => arr[Math.floor(r() * arr.length)];

/** 종목별 최근 가격 (tick 단위, 최대 900개) */
class History {
  private buf = new Map<string, number[]>();
  push(market: Market) {
    for (const q of market.quotes()) {
      let b = this.buf.get(q.sym);
      if (!b) { b = []; this.buf.set(q.sym, b); }
      b.push(q.price);
      if (b.length > 900) b.shift();
    }
  }
  /** n tick 전 가격 (기록이 모자라면 가장 오래된 값) */
  ago(sym: string, n: number) { const b = this.buf.get(sym); return b?.length ? b[Math.max(0, b.length - 1 - n)] : 0; }
  mean(sym: string, n: number) { const b = this.buf.get(sym) ?? []; const s = b.slice(-n); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : 0; }
  /** 최근 n tick의 최고·최저 (마지막 skip tick은 빼고) */
  range(sym: string, n: number, skip = 0) {
    const b = (this.buf.get(sym) ?? []).slice(-n - skip, skip ? -skip : undefined);
    return b.length ? { hi: Math.max(...b), lo: Math.min(...b) } : null;
  }
}

interface Ctx { market: Market; broker: Broker; news: NewsItem[]; hist: History; tick: number }
interface Meta { opened: number; entry: number; peak: number; trough: number; until: number; note?: string }

/** 봇·세력 공통: 주문 도우미와 포지션 메모. 주문 실패(속도 제한·잔고 부족 등)는 조용히 넘긴다 */
abstract class Agent {
  readonly userId: number; readonly name: string; readonly kind: AccountKind;
  protected rand: Rand;
  protected meta = new Map<string, Meta>(); // 종목당 포지션 하나
  private resetCooldown = 0;
  constructor(userId: number, name: string, kind: AccountKind, seed: number) {
    this.userId = userId; this.name = name; this.kind = kind; this.rand = mulberry32(seed * 7919 + userId);
  }
  abstract act(c: Ctx): void;
  /** 성향 이름 (시뮬레이션 통계용) */
  abstract get label(): string;

  /** 내가 건 지정가가 걸린 tick (오래된 주문 취소용) */
  private orderAt = new Map<number, number>();
  /** 지정가. 실패(잔고·속도 제한 등)는 조용히 넘긴다 */
  protected limit(c: Ctx, sym: string, kind: "spot" | "fut", side: "buy" | "sell", price: number, pct: number, lev?: number) {
    try {
      const r = c.broker.limitOrder(this.userId, { sym, kind, side, price, pct: Math.min(100, Math.max(0.5, pct)), lev });
      if (r.order) this.orderAt.set(r.order.id, c.tick);
      return r;
    } catch { return null; }
  }
  /** maxAge tick보다 오래 걸려 있는 지정가 취소 (only가 있으면 그 조건에 맞는 것만) */
  protected cancelStale(c: Ctx, maxAge: number, only?: (o: { side: string; sym: string }) => boolean) {
    const live = c.broker.ordersOf(this.userId), ids = new Set(live.map(o => o.id));
    for (const id of [...this.orderAt.keys()]) if (!ids.has(id)) this.orderAt.delete(id); // 체결·취소된 주문 정리
    for (const o of live) {
      if (!this.orderAt.has(o.id)) this.orderAt.set(o.id, c.tick);
      if (c.tick - this.orderAt.get(o.id)! >= maxAge && (!only || only(o))) { try { c.broker.cancelOrder(this.userId, o.id); } catch { /* 다음 tick */ } }
    }
  }
  protected cancelAll(c: Ctx) { try { c.broker.cancelAll(this.userId); } catch { /* 없거나 속도 제한 */ } }

  /** 다 잃은 뒤 다시 시작하기까지 기다리는 tick */
  protected resetDelay = 600;
  /** 🤖 봇 교대: retiring = 포지션 정리 중, resting = 쉬는 중 (매매 안 함, 랭킹에서 숨음) */
  retiring = false; resting = false;

  run(c: Ctx) {
    if (this.resting) return;
    const acc = c.broker.account(this.userId);
    // 청산·스탑 등으로 사라진 포지션의 메모를 지운다 (주문은 다음 tick에 체결되므로 직전 주문은 이미 반영돼 있다)
    for (const sym of [...this.meta.keys()]) if (!this.fut(c, sym) && !acc.positions.has(sym)) this.meta.delete(sym);
    if (this.retiring) { // 남은 포지션·지정가를 정리하고, 다 비면 쉰다
      if (c.broker.ordersOf(this.userId).length) { this.cancelAll(c); return; }
      if (!acc.futures.size && !acc.positions.size) { this.retiring = false; this.resting = true; this.meta.clear(); c.broker.setResting(this.userId, true); return; }
      for (const f of acc.futures.values()) if (!f.closing) { try { c.broker.closeFuture(this.userId, f.id, 100).catch(() => {}); } catch { /* 다음 tick */ } }
      for (const sym of acc.positions.keys()) { try { c.broker.place(this.userId, sym, "sell", 100).catch(() => {}); } catch { /* 다음 tick */ } }
      return;
    }
    // 거의 다 잃으면 다시 시작 (사람처럼). 세력·고래는 시작 자금의 25% 아래에서
    const eq = c.broker.equity(acc), floor = this.kind === "mm" || this.kind === "whale" ? 500_000 : 2_000;
    if (eq < floor && c.tick > this.resetCooldown) { c.broker.reset(this.userId); this.meta.clear(); this.resetCooldown = c.tick + this.resetDelay; return; }
    this.act(c);
  }
  wake(c: Ctx) { this.resting = false; this.retiring = false; c.broker.setResting(this.userId, false); }

  protected fut(c: Ctx, sym: string) { for (const f of c.broker.account(this.userId).futures.values()) if (f.sym === sym && !f.closing) return f; return undefined; }
  protected lev(c: Ctx, sym: string, want: number) {
    const q = c.market.quote(sym); if (!q) return 0;
    const opts = LEVERAGE[q.market]; let best = opts[0];
    for (const l of opts) if (l <= want) best = l;
    return best;
  }
  protected open(c: Ctx, sym: string, side: "long" | "short", lev: number, pct: number, hold: number, note?: string) {
    if (this.fut(c, sym) || pct <= 0) return;
    const l = this.lev(c, sym, lev); if (!l) return;
    try {
      c.broker.openFuture(this.userId, sym, side, l, Math.min(100, Math.max(0.5, pct))).catch(() => this.meta.delete(sym));
      const p = c.market.quote(sym)!.price;
      this.meta.set(sym, { opened: c.tick, entry: p, peak: p, trough: p, until: c.tick + hold, note });
    } catch { /* 주문 거절 */ }
  }
  protected close(c: Ctx, sym: string) {
    const f = this.fut(c, sym); if (!f) return;
    try { c.broker.closeFuture(this.userId, f.id, 100).then(() => this.meta.delete(sym), () => {}); } catch { /* 다음 tick에 다시 */ }
  }
  protected buy(c: Ctx, sym: string, pct: number, hold: number) {
    try { c.broker.place(this.userId, sym, "buy", pct).catch(() => {}); const p = c.market.quote(sym)!.price; this.meta.set(sym, { opened: c.tick, entry: p, peak: p, trough: p, until: c.tick + hold }); } catch { /* 거절 */ }
  }
  protected sell(c: Ctx, sym: string) {
    try { c.broker.place(this.userId, sym, "sell", 100).then(() => this.meta.delete(sym), () => {}); } catch { /* 거절 */ }
  }
  /** 메모된 포지션마다 콜백 (가격 고점·저점 갱신 포함) */
  protected each(c: Ctx, fn: (sym: string, m: Meta, price: number) => void) {
    for (const [sym, m] of this.meta) {
      const q = c.market.quote(sym); if (!q) { this.meta.delete(sym); continue; }
      m.peak = Math.max(m.peak, q.price); m.trough = Math.min(m.trough, q.price);
      fn(sym, m, q.price);
    }
  }
  /** 보유 시간이 끝난 포지션 정리 */
  protected expire(c: Ctx) {
    this.each(c, (sym, m) => {
      if (c.tick < m.until) return;
      if (this.fut(c, sym)) this.close(c, sym); else if (c.broker.account(this.userId).positions.has(sym)) this.sell(c, sym); else this.meta.delete(sym);
    });
  }
}

const liveSyms = (c: Ctx, kinds: string[] = ["stock", "coin", "venture"]) => c.market.quotes().filter(q => kinds.includes(q.market)).map(q => q.sym);
const companyNews = (c: Ctx) => c.news.filter(n => (n.kind === "기업" || n.kind === "코인") && n.symbols.length === 1);

// ---------- 🤖 봇 성향 ----------
export type BotStyle = "holder" | "levHolder" | "newsChaser" | "ventureBettor" | "random" | "dipBuyer" | "gambler";
/** 100명 기준 섞는 비율. gambler = 올인 고배율, 청산되면 바로 다시 시작하는 도파민형 */
export const BOT_MIX: [BotStyle, number][] = [["holder", 10], ["levHolder", 15], ["newsChaser", 20], ["ventureBettor", 15], ["random", 15], ["dipBuyer", 10], ["gambler", 15]];

class Bot extends Agent {
  private style: BotStyle;
  private p: { lev: number; pct: number; hold: number; delay: number; take: number; cut: number };
  private watch: { sym: string; at: number; price: number; kind: "news" | "venture" }[] = [];
  constructor(userId: number, name: string, seed: number, style: BotStyle) {
    super(userId, name, "bot", seed);
    this.style = style;
    const r = this.rand;
    this.p = {
      lev: pick(r, [2, 3, 5, 5, 10, 10]), pct: uni(r, 10, 70), hold: Math.round(uni(r, 30, 900)),
      delay: Math.round(uni(r, 1, 8)), take: uni(r, 0.03, 0.3), cut: uni(r, 0.02, 0.15),
    };
    if (style === "gambler") this.resetDelay = 30;
  }
  get label() { return this.style; }
  act(c: Ctx) {
    const r = this.rand, acc = c.broker.account(this.userId);
    switch (this.style) {
      case "holder": {
        if (!acc.positions.size && acc.cash > 50_000) {
          const syms = liveSyms(c, ["stock", "coin"]);
          for (let i = 0; i < 2; i++) this.buy(c, pick(r, syms), 45, 1e9);
        }
        return;
      }
      case "levHolder": {
        this.each(c, (sym, m, p) => { if (p / m.entry - 1 > this.p.take) this.close(c, sym); });
        if (!acc.futures.size && r() < 1 / 120) this.open(c, pick(r, liveSyms(c, ["stock", "coin"])), "long", this.p.lev, this.p.pct, this.p.hold * 4);
        this.expire(c);
        return;
      }
      case "newsChaser": {
        for (const n of companyNews(c)) this.watch.push({ sym: n.symbols[0], at: c.tick + this.p.delay, price: c.market.quote(n.symbols[0])?.price ?? 0, kind: "news" });
        this.watch = this.watch.filter(w => {
          if (c.tick < w.at) return true;
          const p = c.market.quote(w.sym)?.price ?? 0;
          if (w.price && p / w.price - 1 > 0.003) this.open(c, w.sym, "long", this.p.lev, this.p.pct / 2, Math.min(this.p.hold, 180));
          return false;
        });
        this.each(c, (sym, m, p) => { if (p / m.entry - 1 < -this.p.cut / this.p.lev) this.close(c, sym); });
        this.expire(c);
        return;
      }
      case "ventureBettor": {
        for (const n of c.news) {
          if (!n.event || n.kind !== "신흥주") continue; // 신흥주 검증만 (지표·루머·행사 예고도 event가 있다)
          const sym = n.symbols[0];
          if (n.event.index === 0) this.watch.push({ sym, at: c.tick + this.p.delay, price: 0, kind: "venture" });
          if (n.event.index === 2 && this.meta.has(sym)) this.meta.get(sym)!.until = c.tick + Math.round(uni(r, 0, 3));
        }
        this.watch = this.watch.filter(w => { if (c.tick < w.at) return true; this.open(c, w.sym, "long", Math.min(5, this.p.lev), this.p.pct, 400); return false; });
        this.expire(c);
        return;
      }
      case "random": {
        if (r() < 1 / 90) {
          const sym = pick(r, liveSyms(c));
          if (r() < 0.5) this.open(c, sym, r() < 0.6 ? "long" : "short", pick(r, [2, 3, 5, 10]), uni(r, 5, 50), Math.round(uni(r, 20, 600)));
          else this.buy(c, sym, uni(r, 5, 40), Math.round(uni(r, 60, 1800)));
        }
        this.expire(c);
        return;
      }
      case "gambler": {
        // 다시 시작 직후 10분은 5배까지만 된다 (서버 규칙)
        const locked = acc.resetAt != null && c.tick - acc.resetAt < 600;
        this.each(c, (sym, m, p) => { const f = this.fut(c, sym); if (f && (p / m.entry - 1) * (f.side === "long" ? 1 : -1) * f.lev > this.p.take * 10) this.close(c, sym); });
        if (!acc.futures.size && r() < 1 / 20) {
          const sym = pick(r, liveSyms(c, r() < 0.3 ? ["venture", "coin"] : ["stock", "coin"]));
          this.open(c, sym, r() < 0.7 ? "long" : "short", locked ? 5 : 10, 100, 1e9);
        }
        return;
      }
      case "dipBuyer": { // 지정가형: 현재가보다 1~4% 아래에 사 두고, 평단 +3%에 매도 지정가. -8%면 손절
        this.cancelStale(c, 900, o => o.side === "buy");
        const orders = c.broker.ordersOf(this.userId);
        for (const [sym, pos] of acc.positions) {
          const p = c.market.quote(sym)?.price ?? 0, selling = orders.find(o => o.sym === sym && o.side === "sell");
          if (p && p < pos.avg * 0.92) { if (selling) { try { c.broker.cancelOrder(this.userId, selling.id); } catch { /* 다음 tick */ } } else this.sell(c, sym); }
          else if (!selling) this.limit(c, sym, "spot", "sell", pos.avg * 1.03, 100);
        }
        if (!acc.positions.size && !orders.length && r() < 1 / 30) {
          const sym = pick(r, liveSyms(c, ["stock", "coin"])), p = c.market.quote(sym)!.price;
          this.limit(c, sym, "spot", "buy", p * (1 - uni(r, 0.01, 0.04)), 30);
        }
      }
    }
  }
}

// ---------- 🏦 세력 ----------
export type MmStyle = "liquidity" | "liqHunter" | "crowdFade" | "momentum" | "meanRevert" | "overvalued" | "undervalued" | "pairArb" | "whale"
  | "rotation" | "quoter" | "trend" | "coinDesk" | "ventureDesk"
  | "reportFollow" | "reportFade" | "breakout" | "dipSniper" | "squeeze" | "pumpDump" | "sectorRotation";
export const MM_NAMES: Record<MmStyle, string> = {
  liquidity: "유동성세력", liqHunter: "청산사냥꾼", crowdFade: "역이용세력", momentum: "모멘텀세력",
  meanRevert: "역추세세력", overvalued: "공매도세력", undervalued: "가치투자세력", pairArb: "차익거래단", whale: "고래",
  // 거래량 세력: 작은 주문을 자주 내서 체결·호가·캔들 거래량을 채운다. 가격 방향은 거의 안 건드린다
  rotation: "회전매매단", quoter: "호가조성단", trend: "추세매매단", coinDesk: "코인데스크", ventureDesk: "신흥주데스크",
  // 엔진에서 뺀 차트 패턴(돌파·숏스퀴즈·설거지)을 실제 주문으로 만드는 세력과, 애널리스트 리포트를 따라가거나 거꾸로 타는 세력
  reportFollow: "리포트추종단", reportFade: "리포트역행단", breakout: "돌파매매단", dipSniper: "급락매수단",
  squeeze: "숏스퀴즈단", pumpDump: "설거지세력", sectorRotation: "섹터순환단",
};
/** 🐋 고래 10마리: 노는 시장·레버리지·비중·빈도(틱당 확률)·보유 시간이 다르다. 첫째는 예전부터 있던 "고래" */
export interface WhaleDef { name: string; kinds: string[]; lev: number; pct: number; chance: number; hold: [number, number] }
export const WHALES: WhaleDef[] = [
  { name: "고래", kinds: ["stock", "coin", "venture"], lev: 10, pct: 40, chance: 1 / 1200, hold: [30, 120] },
  { name: "흰수염고래", kinds: ["stock"], lev: 10, pct: 50, chance: 1 / 1500, hold: [60, 180] },
  { name: "혹등고래", kinds: ["coin"], lev: 5, pct: 40, chance: 1 / 1000, hold: [30, 120] },
  { name: "향유고래", kinds: ["venture"], lev: 5, pct: 30, chance: 1 / 900, hold: [20, 90] },
  { name: "범고래", kinds: ["stock", "coin", "venture"], lev: 5, pct: 25, chance: 1 / 600, hold: [20, 60] },
  { name: "밍크고래", kinds: ["stock"], lev: 3, pct: 30, chance: 1 / 800, hold: [60, 240] },
  { name: "참고래", kinds: ["coin"], lev: 3, pct: 50, chance: 1 / 1200, hold: [120, 480] },
  { name: "귀신고래", kinds: ["stock", "coin"], lev: 10, pct: 20, chance: 1 / 700, hold: [15, 45] },
  { name: "북극고래", kinds: ["stock"], lev: 2, pct: 60, chance: 1 / 2000, hold: [300, 900] },
  { name: "보리고래", kinds: ["venture"], lev: 3, pct: 40, chance: 1 / 1100, hold: [30, 150] },
];
/** 세력이 돌아가며 쓰는 전략 (고래 제외). 세력 이름은 세력1~세력N이라 화면에서는 무슨 전략인지 모른다 */
export const MM_STRATEGIES = (Object.keys(MM_NAMES) as MmStyle[]).filter(s => s !== "whale");
/** 한 전략을 쓰는 시간 (tick): 20~40분. 갈아탈 때 지정가를 취소하고 포지션을 정리한다 */
const MM_PERIOD: [number, number] = [1200, 2400];
/** 회전매매 세력이 도는 시장 */
const DESK: Partial<Record<MmStyle, string[]>> = { rotation: ["stock"], coinDesk: ["coin"], ventureDesk: ["venture"] };
/** 유동성 세력이 지정가를 거는 거리 (현재가 대비) */
const LIQ_GAP: Record<string, number> = { stock: 0.004, coin: 0.008, venture: 0.03 };
/** 세력 세기 (테스트 서버에서 조절). 1 = 기본 */
export interface MmTuning { strength: Partial<Record<MmStyle, number>> }
const FAIR_PER = new Map(ASSETS.filter(a => a.fairPER).map(a => [a.sym, a.fairPER!]));
const PAIRS: [string, string][] = [["BTC", "ETH"], ["NVDA", "AMD"], ["AAPL", "MSFT"], ["GOOGL", "META"], ["JPM", "V"], ["SOL", "XRP"]];

/**
 * 🏦 세력: 전략 목록(cycle)을 계좌 난수로 섞어 두고 20~40분마다 다음 전략으로 갈아탄다 (한 번에 하나: 같은 계좌에서 전략끼리 포지션이 엉키지 않게).
 * 갈아타는 시각은 세력마다 달라 정리 매물이 한꺼번에 몰리지 않는다. 🐋 고래는 전략 하나(whale)만 쓴다
 */
class MarketMaker extends Agent {
  private cycle: MmStyle[]; private at = 0; private nextSwitch: number;
  private strength: Partial<Record<MmStyle, number>>;
  private ventures = new Set<string>();
  private activity = new Map<string, number>(); // 종목별 최근 사람·봇 거래 금액 (감쇠 합)
  private posAt = new Map<number, number>();    // 선물 포지션이 처음 보인 tick
  private whale: WhaleDef | null;
  constructor(userId: number, name: string, seed: number, styles: MmStyle[], strength: Partial<Record<MmStyle, number>> = {}, kind: AccountKind = "mm", whale: WhaleDef | null = null) {
    super(userId, name, kind, seed); this.strength = strength; this.whale = whale;
    const r = this.rand, cycle = [...styles];
    for (let i = cycle.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [cycle[i], cycle[j]] = [cycle[j], cycle[i]]; }
    this.cycle = cycle;
    this.nextSwitch = Math.round(uni(r, 0, MM_PERIOD[1])); // 첫 교대 시각도 세력마다 다르게
  }
  /** 지금 쓰는 전략 */
  private get style(): MmStyle { return this.cycle[this.at]; }
  private get k() { return this.strength[this.style] ?? 1; }
  get label() { return this.whale ? this.whale.name : `${this.name}(${this.style})`; }
  /** 전략을 바꾸기 전에 지정가를 취소하고 포지션을 시장가로 정리한다. 다 비었으면 true */
  private flatten(c: Ctx): boolean {
    const acc = c.broker.account(this.userId);
    if (c.broker.ordersOf(this.userId).length) { this.cancelAll(c); return false; }
    if (!acc.futures.size && !acc.positions.size) return true;
    for (const f of acc.futures.values()) if (!f.closing) { try { c.broker.closeFuture(this.userId, f.id, 100).catch(() => {}); } catch { /* 다음 tick */ } }
    for (const sym of [...acc.positions.keys()]) { try { c.broker.place(this.userId, sym, "sell", 100).catch(() => {}); } catch { /* 다음 tick */ } }
    return false;
  }
  /** 명목 금액 → 예수금 대비 비중(%) */
  private pctFor(c: Ctx, notional: number, lev: number) { const cash = c.broker.account(this.userId).cash; return cash > 0 ? (notional / (lev * cash)) * 100 * this.k : 0; }

  act(c: Ctx) {
    const r = this.rand;
    if (this.cycle.length > 1 && c.tick >= this.nextSwitch) { // 전략 교대: 정리가 끝나면 다음 전략
      if (!this.flatten(c)) return;
      this.at = (this.at + 1) % this.cycle.length;
      this.nextSwitch = c.tick + Math.round(uni(r, ...MM_PERIOD));
      this.meta.clear(); this.posAt.clear(); this.activity.clear(); this.ventures.clear();
      return;
    }
    switch (this.style) {
      case "liquidity": { // 사람·봇이 많이 거래하는 종목 위·아래에 선물 지정가를 두껍게 건다 (A10). 체결되면 120틱 안에 정리
        for (const [sym, v] of this.activity) this.activity.set(sym, v * 0.98);
        for (const [sym, flow] of c.broker.lastFlows) this.activity.set(sym, (this.activity.get(sym) ?? 0) + Math.abs(flow));
        for (const f of c.broker.account(this.userId).futures.values()) {
          if (!this.posAt.has(f.id)) this.posAt.set(f.id, c.tick);
          const q = c.market.quote(f.sym), gain = (f.side === "long" ? 1 : -1) * ((q?.price ?? f.entry) / f.entry - 1);
          if (!f.closing && (c.tick - this.posAt.get(f.id)! > 120 || gain > LIQ_GAP[q?.market ?? "stock"])) {
            try { c.broker.closeFuture(this.userId, f.id, 100).then(() => this.posAt.delete(f.id), () => {}); } catch { /* 다음 tick */ }
          }
        }
        if (c.tick % 30) break;
        this.cancelAll(c);
        const top = [...this.activity].filter(([sym, v]) => v > 0.02 * (c.market.liquidity(sym) ?? Infinity)).sort((a, b) => b[1] - a[1]).slice(0, 6);
        for (const [sym, v] of top) {
          const q = c.market.quote(sym); if (!q) continue;
          const gap = LIQ_GAP[q.market], pct = Math.min(8, this.pctFor(c, Math.min(0.3 * v, 0.05 * (c.market.liquidity(sym) ?? 0)), 2));
          this.limit(c, sym, "fut", "sell", q.price * (1 + gap), pct, this.lev(c, sym, 2));
          this.limit(c, sym, "fut", "buy", q.price * (1 - gap), pct, this.lev(c, sym, 2));
        }
        break;
      }
      case "liqHunter": { // 청산가 뭉치 쪽으로 약하게 민다. 60틱마다
        if (c.tick % 60) break;
        for (const [sym, e] of c.broker.exposure()) {
          const p = c.market.quote(sym)?.price; if (!p || this.meta.has(sym)) continue;
          let down = 0, up = 0;
          for (const l of e.liqs) { const d = l.price / p - 1; if (l.side === "long" && d < 0 && d > -0.015) down += l.notional; if (l.side === "short" && d > 0 && d < 0.015) up += l.notional; }
          const best = Math.max(down, up);
          if (best > 200_000) this.open(c, sym, down >= up ? "short" : "long", 2, this.pctFor(c, Math.min(best, 400_000) * 0.5, 2), 20);
        }
        break;
      }
      case "crowdFade": { // 신흥주 검증에 사람이 몰리면 추가 확인 단계에서 판다
        for (const n of c.news) {
          if (!n.event || n.kind !== "신흥주") continue;
          const sym = n.symbols[0];
          if (n.event.index === 0) this.ventures.add(sym);
          if (n.event.index === 1 && this.ventures.has(sym)) {
            const e = c.broker.exposure().get(sym), crowd = e ? e.long + e.spot : 0;
            if (crowd > 300_000) this.open(c, sym, "short", 2, this.pctFor(c, 0.3 * crowd, 2), 200);
          }
          if (n.event.index === 2) { this.ventures.delete(sym); this.close(c, sym); }
        }
        this.expire(c);
        break;
      }
      case "momentum": { // 급등·급락에 올라탄다. 고점 대비 1.5% 밀리면 정리
        if (c.tick % 30 === 0) for (const sym of liveSyms(c, ["stock", "coin"])) {
          if (this.meta.has(sym)) continue;
          const q = c.market.quote(sym)!, then = c.hist.ago(sym, 300), th = q.market === "coin" ? 0.05 : 0.03;
          if (!then) continue;
          const ret = q.price / then - 1;
          if (Math.abs(ret) > th) this.open(c, sym, ret > 0 ? "long" : "short", 3, 6, 900, ret > 0 ? "up" : "down");
        }
        this.each(c, (sym, m, p) => { if (m.note === "up" ? p < m.peak * 0.985 : p > m.trough * 1.015) this.close(c, sym); });
        this.expire(c);
        break;
      }
      case "meanRevert": { // 1분에 과하게 튄 가격을 받아친다. 절반 되돌리면 정리
        if (c.tick % 10 === 0) for (const sym of liveSyms(c, ["stock", "coin"])) {
          if (this.meta.has(sym)) continue;
          const q = c.market.quote(sym)!, then = c.hist.ago(sym, 60), th = q.market === "coin" ? 0.06 : 0.04;
          if (!then) continue;
          const ret = q.price / then - 1;
          if (Math.abs(ret) > th) this.open(c, sym, ret > 0 ? "short" : "long", 2, 5, 600, String(then));
        }
        this.each(c, (sym, m, p) => { const base = Number(m.note); if (base && Math.abs(p - base) < Math.abs(m.entry - base) * 0.5) this.close(c, sym); });
        this.expire(c);
        break;
      }
      case "overvalued": case "undervalued": { // 가치투자: 적정가(PER 기준)보다 8% 넘게 비싸면 공매도, 싸면 매수. 3% 안으로 돌아오면 정리 (A14)
        if (c.tick % 60) { this.expire(c); break; }
        const short = this.style === "overvalued";
        for (const q of c.market.quotes()) {
          if (q.market !== "stock" || !q.per) continue;
          const dev = q.per / (FAIR_PER.get(q.sym) ?? 15) - 1; // 승격주는 적정 PER 15
          if (!this.meta.has(q.sym) && (short ? dev > 0.08 : dev < -0.08)) this.open(c, q.sym, short ? "short" : "long", 2, Math.min(25, 80 * Math.abs(dev)) * this.k, 7200);
          else if (this.meta.has(q.sym) && Math.abs(dev) < 0.03) this.close(c, q.sym);
        }
        this.expire(c);
        break;
      }
      case "pairArb": { // 같이 움직이던 짝이 2% 넘게 벌어지면 좁히는 쪽에 건다
        if (c.tick % 30) { this.expire(c); break; }
        for (const [x, y] of PAIRS) {
          const px = c.market.quote(x)?.price, py = c.market.quote(y)?.price;
          if (!px || !py) continue;
          const dev = Math.log(px / py) - Math.log(c.hist.mean(x, 600) / c.hist.mean(y, 600));
          const open = this.meta.has(x) || this.meta.has(y);
          if (!open && Math.abs(dev) > 0.02) { this.open(c, dev > 0 ? x : y, "short", 2, 4, 1800); this.open(c, dev > 0 ? y : x, "long", 2, 4, 1800); }
          else if (open && Math.abs(dev) < 0.005) { this.close(c, x); this.close(c, y); }
        }
        this.expire(c);
        break;
      }
      case "rotation": case "coinDesk": case "ventureDesk": { // 회전매매: 매 tick 한 종목을 조금 사고, 10~60틱 뒤 판다 (최대 6종목)
        this.expire(c);
        if (this.meta.size < 6) { const sym = pick(r, liveSyms(c, DESK[this.style])); if (!this.meta.has(sym)) this.buy(c, sym, 1.5 * this.k, Math.round(uni(r, 10, 60))); }
        break;
      }
      case "quoter": { // 호가 조성: 10틱마다 8종목의 최우선 매수·매도 호가에 선물 지정가를 건다. 체결된 포지션은 60틱 안에 정리
        for (const f of c.broker.account(this.userId).futures.values()) {
          if (!this.posAt.has(f.id)) this.posAt.set(f.id, c.tick);
          if (!f.closing && c.tick - this.posAt.get(f.id)! > 60) { try { c.broker.closeFuture(this.userId, f.id, 100).then(() => this.posAt.delete(f.id), () => {}); } catch { /* 다음 tick */ } }
        }
        if (c.tick % 10) break;
        this.cancelAll(c);
        const syms = liveSyms(c, ["stock", "coin"]);
        for (let i = 0; i < 8; i++) {
          const sym = pick(r, syms), b = c.market.best(sym);
          if (b.bid == null || b.ask == null) continue;
          this.limit(c, sym, "fut", "buy", b.bid, this.k, this.lev(c, sym, 2));
          this.limit(c, sym, "fut", "sell", b.ask, this.k, this.lev(c, sym, 2));
        }
        break;
      }
      case "trend": { // 추세 매매: 5틱마다 4종목을 보고 30틱 동안 0.3% 넘게 움직인 쪽으로 작게 탄다 (30~90틱)
        if (c.tick % 5 === 0) for (let i = 0; i < 4; i++) {
          const sym = pick(r, liveSyms(c, ["stock", "coin"]));
          if (this.meta.has(sym)) continue;
          const q = c.market.quote(sym)!, then = c.hist.ago(sym, 30);
          if (!then) continue;
          const ret = q.price / then - 1;
          if (Math.abs(ret) > 0.003) this.open(c, sym, ret > 0 ? "long" : "short", 2, 2 * this.k, Math.round(uni(r, 30, 90)));
        }
        this.expire(c);
        break;
      }
      case "reportFollow": case "reportFade": { // 애널리스트 리포트를 따라(또는 거꾸로) 13분 탄다. 중립은 무시
        for (const n of c.news) {
          const sym = n.symbols[0];
          if (!n.report || !sym || n.report.opinion === "중립" || this.meta.has(sym)) continue;
          const up = (n.report.opinion === "매수") === (this.style === "reportFollow");
          this.open(c, sym, up ? "long" : "short", 2, 5 * this.k, 780);
        }
        this.expire(c);
        break;
      }
      case "breakout": { // 돌파 매매: 15틱마다 5분 신고가·신저가를 돌파한 쪽으로 탄다. 고점(저점) 대비 1.5% 되돌리면 정리
        if (c.tick % 15 === 0) for (const sym of liveSyms(c, ["stock", "coin"])) {
          if (this.meta.has(sym) || this.meta.size >= 5) continue;
          const p = c.market.quote(sym)!.price, box = c.hist.range(sym, 300, 15);
          if (!box) continue;
          if (p > box.hi * 1.002) this.open(c, sym, "long", 3, 4 * this.k, 300, "up");
          else if (p < box.lo * 0.998) this.open(c, sym, "short", 3, 4 * this.k, 300, "down");
        }
        this.each(c, (sym, m, p) => { if (m.note === "up" ? p < m.peak * 0.985 : p > m.trough * 1.015) this.close(c, sym); });
        this.expire(c);
        break;
      }
      case "dipSniper": { // 급락 매수: 1분에 4%(코인 6%) 넘게 빠진 종목 아래에 매수 지정가, 체결되면 +2.5%에 매도 지정가
        this.cancelStale(c, 300, o => o.side === "buy");
        const acc = c.broker.account(this.userId), orders = c.broker.ordersOf(this.userId);
        for (const [sym, pos] of acc.positions) if (!orders.some(o => o.sym === sym && o.side === "sell")) this.limit(c, sym, "spot", "sell", pos.avg * 1.025, 100);
        if (c.tick % 20 === 0) for (const sym of liveSyms(c, ["stock", "coin"])) {
          const q = c.market.quote(sym)!, then = c.hist.ago(sym, 60);
          if (!then || acc.positions.has(sym) || orders.some(o => o.sym === sym)) continue;
          if (q.price / then - 1 < -(q.market === "coin" ? 0.06 : 0.04)) this.limit(c, sym, "spot", "buy", q.price * 0.99, 6 * this.k);
        }
        break;
      }
      case "squeeze": { // 숏스퀴즈: 1분마다 사람·봇 숏이 롱의 2배 넘게 몰린 종목을 사서 숏 청산을 부른다 (2분 보유)
        if (c.tick % 60 === 0) for (const [sym, e] of c.broker.exposure()) {
          if (this.meta.has(sym) || e.short < 300_000 || e.short < 2 * e.long || !c.market.quote(sym)) continue;
          this.open(c, sym, "long", 3, this.pctFor(c, Math.min(e.short, 1_000_000) * 0.5, 3), 120);
        }
        this.expire(c);
        break;
      }
      case "pumpDump": { // 설거지: 가끔 신흥주 하나를 크게 사서 끌어올리고, +15%이거나 5분이 지나면 전부 판다
        if (!this.meta.size && r() < this.k / 600) { const syms = liveSyms(c, ["venture"]); if (syms.length) this.buy(c, pick(r, syms), 15, 300); }
        this.each(c, (sym, m, p) => { if (p / m.entry - 1 > 0.15) this.sell(c, sym); });
        this.expire(c);
        break;
      }
      case "sectorRotation": { // 섹터 순환: 5분마다 10분 수익률이 가장 좋은 업종 상위 2종목으로 갈아탄다 (현물)
        if (c.tick % 300) break;
        const by = new Map<string, { sum: number; n: number; best: [string, number][] }>();
        for (const q of c.market.quotes()) {
          if (q.market !== "stock") continue;
          const then = c.hist.ago(q.sym, 600);
          if (!then) continue;
          const ret = q.price / then - 1, e = by.get(q.sector) ?? { sum: 0, n: 0, best: [] };
          e.sum += ret; e.n++; e.best.push([q.sym, ret]); by.set(q.sector, e);
        }
        const top = [...by.values()].filter(e => e.n >= 2).sort((x, y) => y.sum / y.n - x.sum / x.n)[0];
        if (!top) break;
        const want = new Set(top.best.sort((x, y) => y[1] - x[1]).slice(0, 2).map(x => x[0]));
        for (const sym of c.broker.account(this.userId).positions.keys()) if (!want.has(sym)) this.sell(c, sym);
        for (const sym of want) if (!this.meta.has(sym)) this.buy(c, sym, 10 * this.k, 1e9);
        break;
      }
      case "whale": { // 가끔 아주 큰 주문을 넣고 빠진다. 고래마다 시장·레버리지·비중·빈도가 다르다
        const w = this.whale ?? WHALES[0];
        if (!this.meta.size && r() < this.k * w.chance) this.open(c, pick(r, liveSyms(c, w.kinds)), r() < 0.55 ? "long" : "short", w.lev, w.pct, Math.round(uni(r, ...w.hold)));
        this.expire(c);
      }
    }
  }
}

// ---------- 실행기 ----------
const BOT_NAMES = ["개미", "불개미", "존버", "단타", "코인", "신흥", "레버", "물타기", "손절", "풀매수"];

/** 봇·세력 계정을 만들고(없으면) tick마다 매매시킨다 */
export class BotRunner {
  private agents: Agent[] = [];
  private bots: Agent[] = [];
  private hist = new History();
  private getBroker: () => Broker; private getMarket: () => Market;
  private activeHumans: () => number;

  /**
   * activeHumans: 최근 10분 안에 활동한 사람 수. 사람 + 활동 중인 봇 = bots(기본 100)이 되도록 봇을 한 tick에 1명씩 교대한다.
   * 세력·고래는 교대하지 않는다
   */
  constructor(db: Db, getBroker: () => Broker, getMarket: () => Market,
    opts: { bots: number; marketMakers: boolean; seed: number; tuning?: MmTuning; activeHumans?: () => number }) {
    this.getBroker = getBroker; this.getMarket = getMarket; this.activeHumans = opts.activeHumans ?? (() => 0);
    const ensure = (name: string, kind: AccountKind): number | null => {
      db.prepare("INSERT OR IGNORE INTO users (name, pass, created_at, kind) VALUES (?, '-', ?, ?)").run(name, Date.now(), kind);
      const row = db.prepare("SELECT id, kind FROM users WHERE name = ?").get(name) as { id: number; kind: string };
      if (row.kind === "user") return null; // 사람이 먼저 쓴 이름이면 건너뛴다
      if (row.kind !== kind) { // 예: 세력이던 고래 → 고래. 서버가 이미 불러온 계좌도 바꿔야 랭킹에 맞게 나온다
        db.prepare("UPDATE users SET kind = ? WHERE id = ?").run(kind, row.id);
        getBroker().setKind(row.id, kind);
      }
      return row.id;
    };
    const styles = BOT_MIX.flatMap(([s, w]) => Array.from({ length: w }, () => s));
    for (let i = 0; i < opts.bots; i++) {
      const style = styles[i % styles.length];
      const id = ensure(`${BOT_NAMES[i % BOT_NAMES.length]}봇${String(i + 1).padStart(2, "0")}`, "bot");
      if (id != null) { const b = new Bot(id, `봇${i + 1}`, opts.seed, style); this.agents.push(b); this.bots.push(b); }
    }
    if (opts.marketMakers) {
      // 🏦 세력1~세력N: 전략마다 하나씩이던 예전 계정(유동성세력 등)은 이름만 바꿔 이어 쓴다
      MM_STRATEGIES.forEach((style, i) => {
        const name = `세력${i + 1}`;
        const old = db.prepare("SELECT id FROM users WHERE name = ? AND kind = 'mm'").get(MM_NAMES[style]) as { id: number } | undefined;
        if (old && !db.prepare("SELECT 1 FROM users WHERE name = ?").get(name)) {
          db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, old.id);
          getBroker().setName(old.id, name);
        }
        const id = ensure(name, "mm");
        if (id != null) this.agents.push(new MarketMaker(id, name, opts.seed, MM_STRATEGIES, opts.tuning?.strength, "mm"));
      });
      for (const w of WHALES) { // 🐋 고래는 세력이 아니라 거래자 (별도 탭)
        const id = ensure(w.name, "whale");
        if (id != null) this.agents.push(new MarketMaker(id, w.name, opts.seed, ["whale"], opts.tuning?.strength, "whale", w));
      }
    }
  }
  get size() { return this.agents.length; }
  /** 계좌 id → 성향 (시뮬레이션 통계용) */
  describe() { return this.agents.map(a => ({ userId: a.userId, kind: a.kind, label: a.label })); }

  /** 사람이 늘면 봇 하나를 쉬게 하고, 줄면 하나를 깨운다 (한 tick에 1명) */
  private rotate(c: Ctx) {
    const target = Math.max(0, this.bots.length - this.activeHumans());
    const active = this.bots.filter(b => !b.resting && !b.retiring);
    if (active.length > target) active[active.length - 1].retiring = true;
    else if (active.length < target) { const b = this.bots.find(x => x.resting || x.retiring); if (b) b.wake(c); }
  }

  /** market.step()·checkTriggers() 뒤 tick마다 부른다. 주문은 다음 settle()에서 체결된다 */
  tick(news: NewsItem[]) {
    const market = this.getMarket(), broker = this.getBroker();
    this.hist.push(market);
    const c: Ctx = { market, broker, news, hist: this.hist, tick: market.tick };
    this.rotate(c);
    for (const a of this.agents) a.run(c);
  }
}
