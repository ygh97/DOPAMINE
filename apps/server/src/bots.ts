// 🤖 봇과 🏦 세력 계정. 사람과 같은 Broker 주문 경로(충격·수수료·속도 제한·강제 청산)로 매매한다.
// 서버는 BOTS·MARKET_MAKERS 환경 변수로 켜고, tools/sim-bots.ts는 같은 코드로 졸업률을 잰다.
// 결정은 계좌별 seed 난수로만 한다 (Math.random 금지) → 같은 seed면 같은 결과.
import { ASSETS, LEVERAGE, type Market, type NewsItem } from "@dopamine/engine";
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

  /** 다 잃은 뒤 다시 시작하기까지 기다리는 tick */
  protected resetDelay = 600;

  run(c: Ctx) {
    const acc = c.broker.account(this.userId);
    // 청산·스탑 등으로 사라진 포지션의 메모를 지운다 (주문은 다음 tick에 체결되므로 직전 주문은 이미 반영돼 있다)
    for (const sym of [...this.meta.keys()]) if (!this.fut(c, sym) && !acc.positions.has(sym)) this.meta.delete(sym);
    // 거의 다 잃으면 다시 시작 (사람처럼). 세력은 시작 자금의 25% 아래에서
    const eq = c.broker.equity(acc), floor = this.kind === "mm" ? 500_000 : 2_000;
    if (eq < floor && c.tick > this.resetCooldown) { c.broker.reset(this.userId); this.meta.clear(); this.resetCooldown = c.tick + this.resetDelay; return; }
    this.act(c);
  }

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
          if (!n.event) continue;
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
      case "dipBuyer": {
        if (r() < 1 / 30) for (const sym of liveSyms(c, ["stock", "coin"])) {
          const p = c.market.quote(sym)!.price, then = c.hist.ago(sym, 300);
          if (then && p / then - 1 < -0.03 && !this.meta.has(sym)) { this.buy(c, sym, 30, 900); break; }
        }
        this.each(c, (sym, m, p) => { if (p / m.entry - 1 > 0.03) this.sell(c, sym); });
        this.expire(c);
      }
    }
  }
}

// ---------- 🏦 세력 ----------
export type MmStyle = "liquidity" | "liqHunter" | "crowdFade" | "momentum" | "meanRevert" | "overvalued" | "pairArb" | "whale";
export const MM_NAMES: Record<MmStyle, string> = {
  liquidity: "유동성세력", liqHunter: "청산사냥꾼", crowdFade: "역이용세력", momentum: "모멘텀세력",
  meanRevert: "역추세세력", overvalued: "공매도세력", pairArb: "차익거래단", whale: "고래",
};
/** 세력 세기 (테스트 서버에서 조절). 1 = 기본 */
export interface MmTuning { strength: Partial<Record<MmStyle, number>> }
const FAIR_PER = new Map(ASSETS.filter(a => a.fairPER).map(a => [a.sym, a.fairPER!]));
const PAIRS: [string, string][] = [["BTC", "ETH"], ["NVDA", "AMD"], ["AAPL", "MSFT"], ["GOOGL", "META"], ["JPM", "V"], ["SOL", "XRP"]];

class MarketMaker extends Agent {
  private style: MmStyle; private k: number;
  private ventures = new Set<string>();
  constructor(userId: number, name: string, seed: number, style: MmStyle, strength = 1) {
    super(userId, name, "mm", seed); this.style = style; this.k = strength;
  }
  get label() { return this.style; }
  /** 명목 금액 → 예수금 대비 비중(%) */
  private pctFor(c: Ctx, notional: number, lev: number) { const cash = c.broker.account(this.userId).cash; return cash > 0 ? (notional / (lev * cash)) * 100 * this.k : 0; }

  act(c: Ctx) {
    const r = this.rand;
    switch (this.style) {
      case "liquidity": { // 쏠림 반대편을 받아 준다 (충격 완화). 90틱 보유
        for (const [sym, flow] of c.broker.lastFlows) {
          const L = c.market.liquidity(sym) ?? Infinity;
          if (Math.abs(flow) < 0.05 * L || this.meta.has(sym)) continue;
          this.open(c, sym, flow > 0 ? "short" : "long", 2, this.pctFor(c, 0.5 * Math.abs(flow), 2), 90);
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
          if (!n.event) continue;
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
      case "overvalued": { // PER이 적정보다 크게 높은 주식을 공매도. 식으면 정리
        if (c.tick % 300) { this.expire(c); break; }
        for (const q of c.market.quotes()) {
          if (q.market !== "stock" || !q.per) continue;
          const fair = FAIR_PER.get(q.sym) ?? 15;
          if (q.per > fair * 1.5 && !this.meta.has(q.sym)) this.open(c, q.sym, "short", 2, 8, 3600);
          else if (this.meta.has(q.sym) && q.per < fair * 1.15) this.close(c, q.sym);
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
      case "whale": { // 가끔 아주 큰 주문을 넣고 빠진다
        if (!this.meta.size && r() < this.k / 1200) this.open(c, pick(r, liveSyms(c)), r() < 0.55 ? "long" : "short", 10, 40, Math.round(uni(r, 30, 120)));
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
  private hist = new History();
  private getBroker: () => Broker; private getMarket: () => Market;

  constructor(db: Db, getBroker: () => Broker, getMarket: () => Market, opts: { bots: number; marketMakers: boolean; seed: number; tuning?: MmTuning }) {
    this.getBroker = getBroker; this.getMarket = getMarket;
    const ensure = (name: string, kind: AccountKind): number | null => {
      db.prepare("INSERT OR IGNORE INTO users (name, pass, created_at, kind) VALUES (?, '-', ?, ?)").run(name, Date.now(), kind);
      const row = db.prepare("SELECT id, kind FROM users WHERE name = ?").get(name) as { id: number; kind: string };
      return row.kind === kind ? row.id : null; // 사람이 먼저 쓴 이름이면 건너뛴다
    };
    const styles = BOT_MIX.flatMap(([s, w]) => Array.from({ length: w }, () => s));
    for (let i = 0; i < opts.bots; i++) {
      const style = styles[i % styles.length];
      const id = ensure(`${BOT_NAMES[i % BOT_NAMES.length]}봇${String(i + 1).padStart(2, "0")}`, "bot");
      if (id != null) this.agents.push(new Bot(id, `봇${i + 1}`, opts.seed, style));
    }
    if (opts.marketMakers) for (const style of Object.keys(MM_NAMES) as MmStyle[]) {
      const id = ensure(MM_NAMES[style], "mm");
      if (id != null) this.agents.push(new MarketMaker(id, MM_NAMES[style], opts.seed, style, opts.tuning?.strength[style] ?? 1));
    }
  }
  get size() { return this.agents.length; }
  /** 계좌 id → 성향 (시뮬레이션 통계용) */
  describe() { return this.agents.map(a => ({ userId: a.userId, kind: a.kind, label: a.label })); }

  /** market.step()·checkTriggers() 뒤 tick마다 부른다. 주문은 다음 settle()에서 체결된다 */
  tick(news: NewsItem[]) {
    const market = this.getMarket(), broker = this.getBroker();
    this.hist.push(market);
    const c: Ctx = { market, broker, news, hist: this.hist, tick: market.tick };
    for (const a of this.agents) a.run(c);
  }
}
