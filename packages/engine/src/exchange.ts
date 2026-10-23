// 호가창 거래소 (M8). 엔진(Market)은 화면에 안 나오는 기준가를 만들고, 여기서 호가 봇이 그 근처에 호가를 깐다.
// 사람·봇의 주문은 즉시 체결된다. 화면 가격·캔들·거래량은 모두 이 호가창의 체결값이다.
//
// 호가 봇 규칙 (docs/M8-호가창-설계.md 3장):
// - 중심가 = 기준가 × exp(-기울기 × 재고/유동성). 숏 재고를 떠안으면 중심을 올려 더 비싸게 판다 → 몰려 사면 계속 오른다
// - 기준가에서 x만큼 떨어진 곳까지 깔린 누적 물량 N(x) = L·(x / 2σ일)². 그래서 금액 N을 시장가로 먹으면 √N에 비례해 밀린다
//   (예전 주문 충격 공식과 같은 크기)
// - 재고가 한도를 넘으면 쌓이는 쪽 물량을 줄인다 → 급등락. 아주 먼 가격에는 안전 물량을 둔다 → 호가창이 비지 않는다
// 결정론: 난수를 쓰지 않는다. 같은 엔진 경로 + 같은 주문 순서 = 같은 체결.
import type { Market } from "./market.ts";
import type { Bar, CorporateAction, MarketKind, Quote, StepResult } from "./types.ts";

export type Side = "buy" | "sell";
/** 호가 봇(시스템) 주문의 주인 */
export const MAKER = -1;

export interface BookOrder { id: number; owner: number; sym: string; side: Side; price: number; qty: number; seq: number }
export interface Trade {
  sym: string; price: number; qty: number; tick: number; seq: number;
  /** 시장가·지정가로 호가를 먹은 쪽 */
  taker: number; takerSide: Side; takerOrder: number;
  /** 걸려 있던 호가 쪽 */
  maker: number; makerOrder: number;
}
export interface Level { price: number; qty: number }
export interface BookView { sym: string; bids: Level[]; asks: Level[]; tickSize: number; trades: { price: number; qty: number; side: Side; at: number }[] }

export interface ExchangeOptions {
  levels: number;              // 호가 봇이 한쪽에 까는 단계 수 (중심부터 안전 물량 직전까지 제곱 간격)
  spreadSigma: number;         // 반 스프레드 = σ틱 × 이 값 (최소 호가 단위 1칸)
  skewPerL: number;            // 재고가 유동성 L만큼이면 중심가를 σ일 × 이 값만큼 기울인다
  inventoryCapL: number;       // 재고가 L × 이 값을 넘으면 쌓이는 쪽 물량을 줄인다
  inventoryCut: number;        // 그때 남기는 비율
  backstop: Record<MarketKind, number>; // 안전 물량을 두는 거리 (기준가 대비)
  backstopL: number;           // 안전 물량 = L × 이 값
  tickBp: number;              // 호가 단위 ≈ 가격 × 이 값 (1·2·5 단계로 반올림)
  recentTrades: number;        // 최근 체결 보관 개수
  hedgeRate: number;           // tick마다 재고의 이 비율을 기준가로 정리 (1/60 = 약 1분에 63%)
}

export const EXCHANGE_DEFAULTS: ExchangeOptions = {
  levels: 30, spreadSigma: 0.5, skewPerL: 0.5, inventoryCapL: 3, inventoryCut: 0.3,
  backstop: { stock: 0.1, coin: 0.15, venture: 0.4 }, backstopL: 5, tickBp: 0.0002, recentTrades: 30, hedgeRate: 1 / 60,
};

/** 호가 단위: 가격의 약 tickBp를 1·2·5 단계로. 예) $219 → 0.05, $94,880 → 20, $0.31 → 0.0001 */
export function tickSize(price: number, bp = EXCHANGE_DEFAULTS.tickBp): number {
  const raw = Math.max(price * bp, 1e-8), exp = 10 ** Math.floor(Math.log10(raw)), m = raw / exp;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * exp;
}
const roundTo = (v: number, t: number) => Math.round(v / t) * t;
/** 수량 단위: 주식·신흥주는 1주, 코인은 0.000001개. 호가 봇 물량도 이 단위라 체결 수량이 늘 단위의 배수다 */
export const qtyUnit = (market: MarketKind) => (market === "coin" ? 1e-6 : 1);
const floorTo = (v: number, u: number) => Math.floor(v / u + 1e-9) * u;

/** 종목 하나의 호가창. 매수는 높은 가격 먼저, 매도는 낮은 가격 먼저, 같은 가격이면 먼저 건 주문 먼저 */
class Book {
  bids: BookOrder[] = [];
  asks: BookOrder[] = [];
  side(s: Side) { return s === "buy" ? this.bids : this.asks; }
  insert(o: BookOrder) {
    const arr = this.side(o.side), better = (a: BookOrder) => (o.side === "buy" ? a.price > o.price : a.price < o.price) || (a.price === o.price && a.seq < o.seq);
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (better(arr[mid])) lo = mid + 1; else hi = mid; }
    arr.splice(lo, 0, o);
  }
  remove(pred: (o: BookOrder) => boolean) {
    const out: BookOrder[] = [];
    for (const arr of [this.bids, this.asks]) for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) out.push(...arr.splice(i, 1));
    return out;
  }
}

/** barTraded: 이번 캔들에 실제로 체결된 수량 (캔들 거래량 = 엔진 배경 거래량 + 이것) */
interface SymState { book: Book; bars: Bar[]; last: number; prev: number; engPrev: number; tradedTick: number; barTraded: number; inv: number; cash: number; trades: Trade[] }

export class Exchange {
  readonly market: Market;
  readonly opts: ExchangeOptions;
  private s = new Map<string, SymState>();
  private seq = 0;
  private nextId = 1;

  constructor(market: Market, options: Partial<ExchangeOptions> = {}) {
    this.market = market;
    this.opts = { ...EXCHANGE_DEFAULTS, ...options };
    for (const q of market.quotes()) this.list(q.sym);
  }

  // ---------- 종목 상태 ----------
  private list(sym: string) {
    const q = this.market.quote(sym)!;
    const st: SymState = { book: new Book(), bars: this.market.bars(sym).map(b => ({ ...b })), last: q.price, prev: q.prev, engPrev: q.prev, tradedTick: -1, barTraded: 0, inv: 0, cash: 0, trades: [] };
    this.s.set(sym, st);
    this.requote(sym);
    return st;
  }
  private st(sym: string) { return this.s.get(sym); }
  /** 기준가 (엔진 가격, 화면에 안 나옴) */
  reference(sym: string) { return this.market.quote(sym)?.price ?? 0; }
  tickOf(sym: string) { return tickSize(this.reference(sym), this.opts.tickBp); }

  // ---------- 호가 봇 ----------
  /**
   * 호가 봇 호가를 걷고 기준가·재고에 맞춰 다시 깐다 (tick마다).
   * 기준가가 사람 지정가를 넘어가 있으면(예: 매도 지정가보다 호가 봇 매수 호가가 높음) 호가 봇이 그 지정가를 그 가격에 받는다.
   * 그래서 호가창이 엇갈리지 않고, 가격이 지나간 지정가는 체결된다. 그 체결을 돌려준다
   */
  requote(sym: string): Trade[] {
    const st = this.st(sym), q = this.market.quote(sym);
    if (!st || !q) return [];
    st.book.remove(o => o.owner === MAKER);
    const ref = q.price, L = this.market.liquidity(sym) ?? 1e6, sigma = this.market.sigma(sym) ?? 0.001;
    const sigmaDay = sigma * Math.sqrt(this.market.options.ticksPerDay), o = this.opts, tick = tickSize(ref, o.tickBp);
    const invL = (st.inv * ref) / L; // 재고 (L 단위, 롱 +)
    const center = ref * Math.exp(-o.skewPerL * sigmaDay * invL);
    const half = Math.max(tick / ref, sigma * o.spreadSigma), backstop = o.backstop[q.market], span = backstop * 0.95;
    const crossed = [
      ...this.take(MAKER, this.nextId++, sym, "buy", Infinity, roundTo(center * (1 - half), tick)),
      ...this.take(MAKER, this.nextId++, sym, "sell", Infinity, roundTo(center * (1 + half), tick)),
    ];
    // 누적 물량 N(x) = L (x / Kσ일)², K = 엔진 impactK (기본 2). 그래서 금액 N을 먹으면 Kσ일·√(N/L)만큼 밀린다 (예전 충격 공식과 같은 크기)
    // 단계는 중심 근처는 촘촘하게, 멀수록 넓게(제곱 간격) 안전 물량 직전까지 깐다. 그 사이에 빈 구간이 없다
    const unit = qtyUnit(q.market), K = this.market.options.impactK, N = (x: number) => (L * x * x) / (K * K * sigmaDay * sigmaDay);
    for (const side of ["buy", "sell"] as Side[]) {
      const dir = side === "buy" ? -1 : 1;
      // 재고가 한도를 넘으면 더 쌓이는 쪽(롱 재고면 매수 호가)을 줄인다
      const piling = (side === "buy" && invL > o.inventoryCapL) || (side === "sell" && invL < -o.inventoryCapL);
      const cut = piling ? o.inventoryCut : 1;
      let prevX = 0, pending = 0, prevPrice = NaN;
      for (let i = 0; i < o.levels; i++) {
        const x = Math.min(span, half + (span - half) * (i / Math.max(1, o.levels - 1)) ** 2);
        pending += (N(x) - N(prevX)) * cut; prevX = x;
        const price = Math.max(tick, roundTo(center * (1 + dir * x), tick));
        if (price === prevPrice) continue; // 호가 단위 때문에 같은 가격이면 다음 단계에 합친다
        prevPrice = price;
        const qty = floorTo(pending / price, unit);
        if (qty <= 0) continue; // 1주가 안 되면 다음 단계에 합친다
        this.rest(MAKER, sym, side, price, qty);
        pending -= qty * price;
      }
      const far = Math.max(tick, roundTo(ref * (1 + dir * backstop), tick));
      this.rest(MAKER, sym, side, far, Math.max(unit, floorTo((L * o.backstopL + pending) / far, unit))); // 안전 물량
    }
    return crossed;
  }
  /** 호가 봇 재고·손익 (운영자·시뮬레이션용) */
  makerBook(sym: string) { const st = this.st(sym); return st ? { inv: st.inv, cash: st.cash, value: st.cash + st.inv * st.last } : null; }

  // ---------- 주문 ----------
  private rest(owner: number, sym: string, side: Side, price: number, qty: number): BookOrder {
    const o: BookOrder = { id: this.nextId++, owner, sym, side, price, qty, seq: this.seq++ };
    this.st(sym)!.book.insert(o);
    return o;
  }

  /** 반대편 호가를 먹는다. limit이 있으면 그 가격까지만, budget이 있으면 그 금액까지만 (매수 금액 기준 주문) */
  private take(owner: number, orderId: number, sym: string, side: Side, qty: number, limit?: number, budget?: number): Trade[] {
    const st = this.st(sym)!, opp = st.book.side(side === "buy" ? "sell" : "buy"), trades: Trade[] = [], tick = this.market.tick;
    let left = qty, money = budget ?? Infinity;
    while (opp.length && left > 1e-12 && money > 1e-9) {
      const best = opp[0];
      if (limit != null && (side === "buy" ? best.price > limit : best.price < limit)) break;
      if (best.owner === owner && owner !== MAKER) { opp.shift(); continue; } // 자기 주문끼리는 체결하지 않고 걸린 주문을 뺀다
      const fill = Math.min(left, best.qty, money / best.price);
      if (fill <= 1e-12) break;
      best.qty -= fill; left -= fill; money -= fill * best.price;
      const t: Trade = { sym, price: best.price, qty: fill, tick, seq: this.seq++, taker: owner, takerSide: side, takerOrder: orderId, maker: best.owner, makerOrder: best.id };
      trades.push(t);
      if (best.owner === MAKER || owner === MAKER) { const d = (side === "buy") === (owner === MAKER) ? fill : -fill; st.inv += d; st.cash -= d * best.price; } // 호가 봇 재고 (롱 +)
      if (best.qty <= 1e-12) opp.shift();
    }
    if (trades.length) this.record(sym, trades);
    return trades;
  }
  private record(sym: string, trades: Trade[]) {
    const st = this.st(sym)!, bar = st.bars[st.bars.length - 1];
    for (const t of trades) {
      st.last = t.price; st.tradedTick = t.tick;
      if (bar) { bar.high = Math.max(bar.high, t.price); bar.low = Math.min(bar.low, t.price); bar.close = t.price; bar.volume += Math.round(t.qty); }
      st.barTraded += Math.round(t.qty);
      st.trades.push(t);
    }
    if (st.trades.length > this.opts.recentTrades) st.trades.splice(0, st.trades.length - this.opts.recentTrades);
  }

  /** 시장가: 수량 기준 (매도·청산) 또는 금액 기준 (매수 예산). 즉시 체결된 만큼만 돌려준다 */
  marketOrder(owner: number, sym: string, side: Side, by: { qty: number } | { notional: number }): Trade[] {
    if (!this.st(sym)) return [];
    const id = this.nextId++;
    return "qty" in by ? this.take(owner, id, sym, side, by.qty) : this.take(owner, id, sym, side, Infinity, undefined, by.notional);
  }

  /** 지금 호가창에서 금액 notional로 살 수(팔 수) 있는 수량. 체결하지 않고 계산만 한다 */
  qtyFor(owner: number, sym: string, side: Side, notional: number): number {
    const st = this.st(sym);
    if (!st) return 0;
    let qty = 0, money = notional;
    for (const o of st.book.side(side === "buy" ? "sell" : "buy")) {
      if (o.owner === owner && owner !== MAKER) continue;
      const q = Math.min(o.qty, money / o.price);
      qty += q; money -= q * o.price;
      if (money <= 1e-9) break;
    }
    return qty;
  }

  /** 재시작 때 DB에 남은 지정가를 다시 건다 (id·가격·순서 그대로) */
  restoreOrder(o: BookOrder) {
    const st = this.st(o.sym);
    if (!st) return false;
    st.book.insert({ ...o });
    this.nextId = Math.max(this.nextId, o.id + 1);
    this.seq = Math.max(this.seq, o.seq + 1);
    return true;
  }
  /** 사람·봇 주문을 모두 뺀다 (재시작 때 DB 기준으로 다시 걸기 전에) */
  clearPeopleOrders() { for (const st of this.s.values()) st.book.remove(o => o.owner !== MAKER); }

  /** 지정가: 맞는 호가가 있으면 바로 체결하고, 남은 수량은 호가창에 건다 */
  limitOrder(owner: number, sym: string, side: Side, price: number, qty: number): { order: BookOrder | null; trades: Trade[] } {
    if (!this.st(sym) || !(qty > 0) || !(price > 0)) return { order: null, trades: [] };
    const px = roundTo(price, this.tickOf(sym)) || this.tickOf(sym), id = this.nextId++;
    const trades = this.take(owner, id, sym, side, qty, px);
    const left = qty - trades.reduce((s, t) => s + t.qty, 0);
    if (left <= 1e-12) return { order: null, trades };
    const o: BookOrder = { id, owner, sym, side, price: px, qty: left, seq: this.seq++ };
    this.st(sym)!.book.insert(o);
    return { order: o, trades };
  }

  cancel(owner: number, orderId: number): BookOrder | null {
    for (const st of this.s.values()) { const [o] = st.book.remove(x => x.id === orderId && x.owner === owner); if (o) return o; }
    return null;
  }
  /** 사람·봇이 건 주문 (호가 봇 제외) */
  openOrders(owner?: number): BookOrder[] {
    const out: BookOrder[] = [];
    for (const st of this.s.values()) for (const arr of [st.book.bids, st.book.asks]) for (const o of arr) if (o.owner !== MAKER && (owner == null || o.owner === owner)) out.push(o);
    return out;
  }

  // ---------- 시세 ----------
  best(sym: string) { const b = this.st(sym)?.book; return { bid: b?.bids[0]?.price ?? null, ask: b?.asks[0]?.price ?? null }; }
  price(sym: string) { return this.st(sym)?.last ?? 0; }

  /** 엔진 시세에 체결가를 덮어쓴다. PER·시총도 같은 비율로 */
  quote(sym: string): Quote | null {
    const q = this.market.quote(sym), st = this.st(sym);
    if (!q || !st) return q;
    const k = st.last / q.price;
    return { ...q, price: st.last, prev: st.prev, per: q.per && q.per * k, cap: q.cap && q.cap * k };
  }
  quotes(): Quote[] { return this.market.quotes().map(q => this.quote(q.sym)!); }
  bars(sym: string): readonly Bar[] { return this.st(sym)?.bars ?? []; }
  get tick() { return this.market.tick; }
  liquidity(sym: string) { return this.market.liquidity(sym); }
  /** 가상 금융위기 투매 구간인지 (서버의 세력·고래용, 화면으로 내보내지 않는다) */
  crashing() { return this.market.crashing(); }
  /** 결과가 정해진 예약 사건 (세력 선취매용, 서버 전용) */
  insider(within: number) { return this.market.insider(within); }

  book(sym: string, depth = 10): BookView | null {
    const st = this.st(sym);
    if (!st) return null;
    const agg = (arr: BookOrder[]) => {
      const out: Level[] = [];
      for (const o of arr) { const l = out[out.length - 1]; if (l && l.price === o.price) l.qty += o.qty; else if (out.length < depth) out.push({ price: o.price, qty: o.qty }); else break; }
      return out;
    };
    return { sym, bids: agg(st.book.bids), asks: agg(st.book.asks), tickSize: this.tickOf(sym), trades: st.trades.slice().reverse().map(t => ({ price: t.price, qty: t.qty, side: t.takerSide, at: t.tick })) };
  }

  // ---------- tick ----------
  /** 엔진 1 tick → 상장 변화 반영 → 캔들 → 호가 봇 재호가. 취소된 사람 주문(폐지·병합)과 재호가 때 호가 봇이 받은 지정가 체결도 돌려준다 */
  step(): StepResult & { cancelled: BookOrder[]; trades: Trade[] } {
    const r = this.market.step(), cancelled: BookOrder[] = [], trades: Trade[] = [];
    for (const a of r.actions) cancelled.push(...this.applyAction(a));
    for (const q of this.market.quotes()) if (!this.st(q.sym)) this.list(q.sym);
    for (const [sym, st] of this.s) {
      // 재고 헤지: 쌓인 재고를 tick마다 조금씩 바깥(기준가)에서 정리한다. 그래서 밀린 가격이 천천히 기준가로 돌아간다
      const hedge = st.inv * this.opts.hedgeRate, ref = this.reference(sym);
      st.inv -= hedge; st.cash += hedge * ref;
      trades.push(...this.requote(sym)); // 새 기준가로 먼저 깔아야 가격이 한 tick 늦지 않는다
    }
    for (const q of this.market.quotes()) {
      const st = this.st(q.sym)!, eng = this.market.bars(q.sym), eb = eng[eng.length - 1];
      // 거래가 없던 종목은 가격이 기준가 근처(호가 중간값)를 따라간다
      if (st.tradedTick !== this.market.tick) { const { bid, ask } = this.best(q.sym); if (bid != null && ask != null) st.last = (bid + ask) / 2; }
      // 등락률 기준가: 엔진이 하루를 넘기면 그때의 체결가로
      if (q.prev !== st.engPrev) { st.engPrev = q.prev; st.prev = st.last; }
      const bar = st.bars[st.bars.length - 1];
      if (eb && (!bar || eb.timestamp !== bar.timestamp)) {
        st.barTraded = 0;
        st.bars.push({ timestamp: eb.timestamp, open: st.last, high: st.last, low: st.last, close: st.last, volume: eb.volume });
        if (st.bars.length > this.market.options.maxBars) st.bars.splice(0, st.bars.length - this.market.options.maxBars);
      } else if (bar) {
        bar.high = Math.max(bar.high, st.last); bar.low = Math.min(bar.low, st.last); bar.close = st.last;
        if (eb) bar.volume = eb.volume + st.barTraded; // 엔진의 배경 거래량 + 실제 체결 (A9)
      }
    }
    return { ...r, cancelled, trades };
  }

  /** 주식병합: 가격·수량을 비율대로, 걸린 주문은 취소. 폐지: 호가창을 닫고 걸린 주문을 돌려준다 */
  private applyAction(a: CorporateAction): BookOrder[] {
    const st = this.st(a.sym);
    if (!st) return [];
    if (a.type === "delist") { this.s.delete(a.sym); return st.book.remove(o => o.owner !== MAKER); }
    if (a.type !== "split") return [];
    const out = st.book.remove(o => o.owner !== MAKER);
    for (const b of st.bars) { b.open *= a.ratio; b.high *= a.ratio; b.low *= a.ratio; b.close *= a.ratio; b.volume = Math.round(b.volume / a.ratio); }
    st.last *= a.ratio; st.prev *= a.ratio; st.engPrev = this.market.quote(a.sym)?.prev ?? st.engPrev; st.inv /= a.ratio;
    return out;
  }

  // ---------- 스냅샷 ----------
  snapshot(): string {
    const syms: Record<string, unknown> = {};
    for (const [sym, st] of this.s) syms[sym] = { ...st, book: { bids: st.book.bids.filter(o => o.owner !== MAKER), asks: st.book.asks.filter(o => o.owner !== MAKER) } };
    return JSON.stringify({ v: 1, seq: this.seq, nextId: this.nextId, syms });
  }
  restore(json: string) {
    const d = JSON.parse(json);
    this.seq = d.seq; this.nextId = d.nextId; this.s.clear();
    for (const [sym, raw] of Object.entries(d.syms as Record<string, SymState & { book: { bids: BookOrder[]; asks: BookOrder[] } }>)) {
      const book = new Book();
      for (const o of [...raw.book.bids, ...raw.book.asks]) book.insert(o);
      this.s.set(sym, { ...raw, book });
      this.requote(sym);
    }
  }
}
