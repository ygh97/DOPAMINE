// 도파민 센터 시세 엔진. 서버 GameLoop가 1초마다 step()을 부른다.
//
// 틱 수익률 r = 시장 요인 × 베타 + 업종 요인 × 업종 베타 + 개별 노이즈 × 변동성 군집
//             + 뉴스 반응(즉시 → 따라붙음 → 과열 되돌림) + 적정가 회귀
//             + RSI 기울기(국면에 따라 역추세/추세) + 지지·저항 + 점프
// 숨은 상태(대기 충격, 국면, 앵커, EPS)는 이 모듈 밖으로 나가지 않는다. 밖으로는 Quote·Bar·NewsItem만.
import { NEWS, type Template } from "./news-templates.ts";
import type { AssetDef, Bar, CorporateAction, GameDate, MarketKind, MarketOptions, NewsItem, Quote, SpareDef, StepResult } from "./types.ts";

export const DEFAULT_OPTIONS: MarketOptions = {
  ticksPerBar: 60,        // 1분봉 = 60틱(1초 tick)
  ticksPerDay: 80,        // 게임 하루
  barMs: 60_000,
  warmupBars: 720,        // 시작 전 과거 차트
  maxBars: 1500,
  newsGap: [6, 14],       // 뉴스 간격(틱)
  marketSigma: 0.0007,
  sectorSigma: 0.0012,    // 같은 업종끼리 상관 약 0.4
  kappa: 0.0006,          // 적정가 회귀 강도 (반감기 약 1,150틱)
  rsiPeriod: 14,
  rsiWeight: 0.25,        // RSI 기울기 최대치 = 개별 σ의 25%
  regimeSwitch: 1 / 400,  // 국면 전환 확률(틱당)
  flipChance: 0.15,       // 뉴스 반응이 반대로 나올 확률
  srLookback: 60,         // 전고점·전저점을 볼 봉 수
  srBand: 0.004,          // 지지·저항이 작동하는 거리 (0.4%)
  srWeight: 0.35,         // 지지·저항 기울기 최대치 = 개별 σ의 35%
  gradCap: 8e9,           // 신흥주 → 주식 승격: 검증 성공 gradSuccesses회 이상 + 시총 80억 달러
  gradSuccesses: 2,
  gradCooldown: 108_000,  // 승격 사이 평균 간격(30시간 ±30%). 첫 승격은 시즌 시작 약 15시간 뒤 → 1주 동안 고르게 퍼진다
  gradPER: 15,
  splitPrice: 0.1,        // 신흥주 가격이 $0.10 아래면 주식병합(10:1)
  delistCap: 5e7,         // 시총 5천만 달러 아래면 관리종목 → 유예 기간 뒤에도 미달이면 상장폐지
  watchTicks: 2400,       // 관리종목 유예 기간 (게임 30일 = 40분)
  rescueOdds: [0.3, 0.3], // 유예 중 회생 이벤트 확률: [인수 제안, 유상증자], 나머지는 소식 없음
  maxNewGrowth: 5,        // 신성장(승격 종목) 최대 개수. 다 차면 더 승격하지 않는다
  epsStep: [0.02, 0.05],  // 실적 뉴스 1건당 EPS 변화
  epsHalfLife: 172_800,   // EPS가 기준값으로 돌아가는 반감기(틱, 2일)
  epsBand: [0.4, 3],      // EPS(= 적정가)는 기준의 0.4~3배 안에서만 움직인다
  // 플레이어 주문 충격: 충격 = impactK × σ_일 × √(명목 금액 / 가상 유동성)
  impactK: 2,
  impactCap: { stock: 0.03, coin: 0.05, venture: 0.15 }, // tick당 충격 상한
  impactTempShare: 0.7,   // 충격 중 사라지는 몫. 나머지 30%는 적정가에 남는다
  impactRevertTicks: 60,  // 사라지는 몫이 되돌아가는 기간
};

const KIND: Record<MarketKind, { sigma: number; betaM: number; betaS: number; jump: number }> = {
  stock: { sigma: 0.0012, betaM: 1, betaS: 1, jump: 0 },
  coin: { sigma: 0.0025, betaM: 0.6, betaS: 1.8, jump: 0.002 },
  venture: { sigma: 0.0035, betaM: 0.5, betaS: 0.8, jump: 0.003 },
};

interface Impulse { total: number; w: number[]; i: number; delay: number }

interface AssetState extends AssetDef {
  def: AssetDef;
  sigma: number;
  betaM: number;
  betaS: number;
  jump: number;
  prev: number;
  eps: number | null;
  baseEps: number | null;
  anchor: number;
  shares: number | null;
  variance: number;
  regime: "range" | "trend";
  pending: Impulse[];
  bars: Bar[];
  rsi: number;
  avgGain: number;
  avgLoss: number;
  lastClose: number;
  hi: number | null;
  lo: number | null;
  breakBar: number;
  volBoost: number;
  successes: number;
  stage: string | null;
  watchUntil: number | null;
  par: number | null; // 액면가 (AssetDef.parValue는 시즌 시작 값)
  splitFactor: number;
}

export interface CreateMarketInput {
  assets: AssetDef[];
  sectors: Record<string, string>;
  spares?: SpareDef[];
  seed?: number;
  now?: number;
  options?: Partial<MarketOptions>;
  /** Market.snapshot()으로 만든 JSON. 주면 과거 차트를 다시 만들지 않고 그 상태에서 이어간다 */
  snapshot?: string;
}

export interface Market {
  readonly options: MarketOptions;
  readonly tick: number;
  readonly assetsVersion: number;
  readonly news: readonly NewsItem[];
  step(): StepResult;
  gameDate(): GameDate;
  quotes(): Quote[];
  quote(sym: string): Quote | null;
  bars(sym: string): readonly Bar[];
  /** 가상 유동성 L (게임 하루 거래대금, 달러). 보유 한도 계산에 쓴다 */
  liquidity(sym: string): number | null;
  /**
   * 이번 tick에 모인 순매수(+)·순매도(-) 명목 금액을 가격에 반영하고 체결 기준가를 돌려준다.
   * step() 전에 종목마다 한 번 부른다. 같은 tick 주문은 모두 이 가격에 체결된다.
   */
  applyFlow(sym: string, notional: number): { price: number; impact: number } | null;
  /** 엔진 전체 상태를 JSON으로 (난수 상태 포함). createMarket({ snapshot })으로 이어서 돌릴 수 있다 */
  snapshot(): string;
}

// 내부 상태를 꺼내고 넣을 수 있는 난수 (스냅샷용)
function mulberry32(seed: number) {
  let a = seed;
  const next = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, get: () => a, set: (v: number) => { a = v; } };
}

/** 나중에 실행할 일. 함수 대신 데이터로 들고 있어야 스냅샷에 담을 수 있다 */
type Task =
  | { at: number; kind: "venture1" | "venture2"; sym: string; success: boolean; eventId: string }
  | { at: number; kind: "list" }
  | { at: number; kind: "rescue"; sym: string };
const SNAPSHOT_VERSION = 1;

export function createMarket({ assets, sectors, spares = [], seed = 20261021, now = Date.now(), options = {}, snapshot }: CreateMarketInput): Market {
  const cfg: MarketOptions = { ...DEFAULT_OPTIONS, ...options };
  const rng = mulberry32(seed), rand = rng.next;
  const uni = (a: number, b: number) => a + (b - a) * rand();
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
  const sign = () => (rand() < 0.5 ? -1 : 1);

  let startTime = Math.floor(now / cfg.barMs) * cfg.barMs - (cfg.warmupBars - 1) * cfg.barMs;
  let tick = 0, nextNewsAt = 3, warm = true, assetsVersion = 0, nextGradAt = Infinity;
  let news: NewsItem[] = [];
  let actions: CorporateAction[] = []; // 이번 tick의 주식병합·폐지·승격·상장 (서버가 보유 정산에 쓴다)
  let scheduled: Task[] = [];
  let marketPending: Impulse[] = [];
  let sectorPending: Record<string, Impulse[]> = {};
  let venturesBusy = new Set<string>();
  let sparePool: SpareDef[] = spares.map(s => ({ ...s }));
  let state: Record<string, AssetState> = {};
  const live = () => Object.values(state);

  function addAsset(def: AssetDef) {
    sectorPending[def.sector] ??= [];
    state[def.sym] = {
      ...def, ...KIND[def.market], def,
      prev: def.price,
      eps: def.market === "stock" && def.fairPER ? def.price / def.fairPER : null,
      baseEps: def.market === "stock" && def.fairPER ? def.price / def.fairPER : null,
      anchor: def.price,
      shares: def.cap ? def.cap / def.price : null,
      variance: 1, regime: rand() < 0.5 ? "range" : "trend",
      pending: [], bars: [], rsi: 50, avgGain: 0, avgLoss: 0, lastClose: def.price,
      hi: null, lo: null, breakBar: -1, volBoost: 0, successes: 0, stage: null, watchUntil: null,
      par: def.parValue ?? null, splitFactor: 1,
    };
    assetsVersion++;
  }
  assets.forEach(addAsset);
  for (const k in sectors) sectorPending[k] ??= [];

  // ---------- 충격 ----------
  function impulse(list: Impulse[], total: number, n = Math.round(uni(15, 40)), delay = 0) {
    const w = Array.from({ length: n }, (_, i) => Math.exp(-i / (n / 3)));
    const s = w.reduce((a, b) => a + b, 0);
    list.push({ total, w: w.map(x => x / s), i: 0, delay });
  }
  function drain(list: Impulse[]): number {
    let sum = 0;
    for (let j = list.length - 1; j >= 0; j--) {
      const it = list[j];
      if (it.delay > 0) { it.delay--; continue; }
      sum += it.total * it.w[it.i++];
      if (it.i >= it.w.length) list.splice(j, 1);
    }
    return sum;
  }
  // 뉴스 반응 모양: 즉시 45% → 따라붙어 (55% + 과열분) → 과열분만큼 되돌림. 합계는 total.
  function react(list: Impulse[], total: number) {
    const over = rand() < 0.6 ? uni(0.1, 0.5) : 0;
    impulse(list, total * 0.45, Math.round(uni(3, 8)));
    impulse(list, total * (0.55 + over), Math.round(uni(20, 40)), 3);
    if (over) impulse(list, -total * over, Math.round(uni(30, 60)), Math.round(uni(45, 75)));
  }
  // 의도한 충격 → 실제 반영량 (0.3~1.5배, 가끔 반대)
  const realize = (intended: number, flip = cfg.flipChance) => intended * uni(0.3, 1.5) * (rand() < flip ? -1 : 1);

  // ---------- 시간 ----------
  // 시즌 달력은 과거 차트(warmup)가 끝난 시점부터 1년차 1월 1일. 그 전은 year 0 = "시즌 전"
  const seasonStartTick = cfg.warmupBars * cfg.ticksPerBar;
  const gameDate = (t = tick): GameDate => {
    const d = Math.floor((t - seasonStartTick) / cfg.ticksPerDay);
    if (d < 0) return { year: 0, month: 0, day: 0 };
    return { year: Math.floor(d / 360) + 1, month: Math.floor((d % 360) / 30) + 1, day: (d % 30) + 1 };
  };
  const barTime = (t = tick) => startTime + Math.floor((t - 1) / cfg.ticksPerBar) * cfg.barMs;
  const nid = () => Math.floor(rand() * 2 ** 32).toString(36) + tick.toString(36);
  const capOf = (a: AssetState) => (a.shares ? a.shares * a.price : null);

  function publish(n: Omit<NewsItem, "id" | "tick" | "at" | "date" | "priceAt">): NewsItem {
    const item: NewsItem = {
      id: nid(), tick, at: barTime(Math.max(1, tick)), date: gameDate(), ...n,
      priceAt: Object.fromEntries(n.symbols.filter(s => state[s]).map(s => [s, state[s].price])),
    };
    news.unshift(item);
    if (news.length > 300) news.pop();
    return item;
  }
  const fillOf = (a: AssetState) => (s: string) => s.replaceAll("{name}", a.name).replaceAll("{sym}", a.sym)
    .replaceAll("{product}", a.product || "주력 제품").replaceAll("{tech}", a.tech || "핵심 기술");

  // ---------- 뉴스 ----------
  function marketNews() {
    const good = rand() < 0.5, tpl = pick(good ? NEWS.market.good : NEWS.market.bad);
    react(marketPending, realize((good ? 1 : -1) * uni(0.004, 0.012)));
    publish({ kind: "시장", headline: tpl.h, body: tpl.b, symbols: [] });
  }
  function sectorNews() {
    const members = (key: string) => live().filter(a => a.sector === key).map(a => a.sym);
    const key = pick(Object.keys(sectors).filter(k => k !== "venture" && members(k).length)), name = sectors[key];
    const good = rand() < 0.5, tpl = pick(good ? NEWS.sector.good : NEWS.sector.bad);
    react(sectorPending[key], realize((good ? 1 : -1) * uni(0.006, 0.02)));
    publish({ kind: "업종", sector: key, headline: `${name} 업종 · ${tpl.h}`, body: tpl.b.replaceAll("{sector}", name), symbols: members(key) });
  }
  function companyNews() {
    const a = pick(live().filter(x => x.market !== "venture"));
    const good = rand() < 0.5, src = a.market === "coin" ? NEWS.coin : NEWS.company;
    const tpl: Template = pick(good ? src.good : src.bad);
    react(a.pending, realize((good ? 1 : -1) * (a.market === "coin" ? uni(0.02, 0.06) : uni(0.01, 0.04))));
    if (tpl.eps && a.eps) a.eps *= 1 + (good ? 1 : -1) * uni(...cfg.epsStep); // 실적·가이던스 → 적정가 이동
    const fill = fillOf(a);
    publish({ kind: a.market === "coin" ? "코인" : "기업", headline: `${a.name} · ${fill(tpl.h)}`, body: fill(tpl.b), symbols: [a.sym] });
  }
  // 신흥주 3단계 검증: 최초 주장 → 재현 시험 → 성공/실패
  function ventureEvent() {
    const free = live().filter(a => a.market === "venture" && !venturesBusy.has(a.sym) && a.watchUntil == null);
    if (!free.length) return companyNews();
    const a = pick(free), success = rand() < 0.5, eventId = nid();
    venturesBusy.add(a.sym);
    react(a.pending, realize(uni(0.05, 0.15)));
    a.stage = "기술검증";
    ventureStage(a, 0, success, eventId, NEWS.venture[0]);
    const t1 = tick + Math.round(uni(25, 50)), t2 = t1 + Math.round(uni(25, 50));
    scheduled.push({ at: t1, kind: "venture1", sym: a.sym, success, eventId });
    scheduled.push({ at: t2, kind: "venture2", sym: a.sym, success, eventId });
  }
  function ventureStage(a: AssetState, i: number, success: boolean, eventId: string, tpl: Template) {
    const fill = fillOf(a);
    publish({
      kind: "신흥주", headline: `${a.name}(${a.sym}) · ${fill(tpl.h)}`, body: fill(tpl.b), symbols: [a.sym],
      event: { id: eventId, index: i, total: 3, label: ["최초 보도", "추가 확인", success ? "확인" : "정정"][i] },
    });
  }
  function runTask(t: Task) {
    if (t.kind === "list") return listNew();
    if (t.kind === "rescue") return rescue(t.sym);
    if (t.kind === "venture1") {
      const a = state[t.sym];
      if (!a) return;
      react(a.pending, realize(sign() * uni(0, 0.05)));
      return ventureStage(a, 1, t.success, t.eventId, NEWS.venture[1]);
    }
    venturesBusy.delete(t.sym);
    const a = state[t.sym];
    if (!a) return;
    // 결과는 로그 기준 대칭: 성공 +35%~+120%, 실패 -33%~-63%. 적정가(앵커)도 같은 만큼 이동
    const move = t.success ? uni(0.3, 0.8) : -uni(0.4, 1.0);
    a.anchor *= Math.exp(move);
    react(a.pending, move);
    if (t.success) a.successes++;
    a.stage = t.success ? "매출검증" : "상장유지심사";
    ventureStage(a, 2, t.success, t.eventId, NEWS.venture[t.success ? 2 : 3]);
  }
  function noiseNews() {
    const tpl = pick(NEWS.noise);
    publish({ kind: "잡담", headline: tpl.h, body: tpl.b, symbols: [] });
  }
  function makeNews() {
    const r = rand();
    // 과거 차트 구간 앞 80%에서는 신흥주 검증을 생략해 시작가 맞추기(rebase) 때 비율이 극단적이지 않게
    const ventureOk = !warm || tick > cfg.warmupBars * cfg.ticksPerBar * 0.8;
    if (r < 0.15) marketNews();
    else if (r < 0.4) sectorNews();
    else if (r < 0.87) companyNews();
    else if (r < 0.9 && ventureOk) ventureEvent();
    else noiseNews();
  }

  // ---------- 신흥주 승격 · 상장폐지 · 신규 상장 ----------
  function graduate(a: AssetState) {
    const fill = fillOf(a);
    Object.assign(a, KIND.stock, { market: "stock", sector: "newgrowth", sigma: 0.0016, fairPER: cfg.gradPER, eps: a.price / cfg.gradPER, baseEps: a.price / cfg.gradPER, stage: null });
    sectorPending.newgrowth ??= [];
    actions.push({ type: "graduate", sym: a.sym });
    nextGradAt = tick + Math.round(cfg.gradCooldown * uni(0.7, 1.3)); // 간격도 조금씩 다르게
    assetsVersion++;
    publish({ kind: "기업", headline: `${a.name}(${a.sym}) · ${fill(NEWS.listing.graduate.h)}`, body: fill(NEWS.listing.graduate.b), symbols: [a.sym] });
    scheduled.push({ at: tick + Math.round(uni(40, 80)), kind: "list" }); // 신흥주 자리 채우기
  }
  function delist(a: AssetState) {
    const fill = fillOf(a);
    publish({ kind: "신흥주", headline: `${a.name}(${a.sym}) · ${fill(NEWS.listing.delist.h)}`, body: fill(NEWS.listing.delist.b), symbols: [a.sym], delisted: true });
    actions.push({ type: "delist", sym: a.sym, price: a.price });
    delete state[a.sym];
    assetsVersion++;
    sparePool.push({ sym: a.sym, name: a.name, tech: a.tech || "핵심 기술", parValue: a.def.parValue }); // 나중에 재상장 후보로
    scheduled.push({ at: tick + Math.round(uni(40, 80)), kind: "list" });
  }

  // 주식병합: 가격이 너무 낮으면 10:1(필요하면 100:1)로 합친다. 시총은 그대로, 과거 차트도 같은 비율로 맞춘다
  function reverseSplit(a: AssetState) {
    let ratio = 10;
    while (a.price * ratio < cfg.splitPrice * 10) ratio *= 10;
    for (const b of a.bars) { b.open *= ratio; b.high *= ratio; b.low *= ratio; b.close *= ratio; b.volume = Math.round(b.volume / ratio); }
    a.price *= ratio; a.prev *= ratio; a.lastClose *= ratio; a.avgGain *= ratio; a.avgLoss *= ratio; a.anchor *= ratio;
    if (a.hi != null) a.hi *= ratio;
    if (a.lo != null) a.lo *= ratio;
    if (a.shares) a.shares /= ratio;
    const parBefore = a.par;
    if (a.par) a.par *= ratio; // 액면병합
    a.splitFactor *= ratio;
    for (const n of news) if (n.priceAt[a.sym]) n.priceAt[a.sym] *= ratio;
    const fill = fillOf(a), money = (v: number | null) => (v == null ? "-" : `$${v.toFixed(2)}`);
    const text = (x: string) => fill(x).replaceAll("{ratio}", String(ratio)).replaceAll("{parBefore}", money(parBefore)).replaceAll("{parAfter}", money(a.par));
    publish({ kind: "신흥주", headline: `${a.name}(${a.sym}) · ${text(NEWS.listing.split.h)}`, body: text(NEWS.listing.split.b), symbols: [a.sym] });
    actions.push({ type: "split", sym: a.sym, ratio });
    assetsVersion++;
  }

  // 관리종목: 시총 기준에 걸리면 바로 폐지하지 않고 유예. 기간 중 회생 이벤트가 한 번 굴러간다
  function designate(a: AssetState) {
    const fill = fillOf(a);
    a.watchUntil = tick + cfg.watchTicks;
    a.stage = "관리종목";
    publish({ kind: "신흥주", headline: `${a.name}(${a.sym}) · ${fill(NEWS.listing.watch.h)}`, body: fill(NEWS.listing.watch.b), symbols: [a.sym] });
    scheduled.push({ at: tick + Math.round(uni(0.2, 0.8) * cfg.watchTicks), kind: "rescue", sym: a.sym });
  }
  function rescue(sym: string) {
    const a = state[sym];
    if (!a || a.watchUntil == null) return;
    const r = rand(), fill = fillOf(a);
    if (r < cfg.rescueOdds[0]) { // 인수 제안: 급등, 적정가도 같이 오른다
      const move = uni(0.4, 0.9);
      a.anchor *= Math.exp(move);
      react(a.pending, move);
      publish({ kind: "신흥주", headline: `${a.name}(${a.sym}) · ${fill(NEWS.listing.acquire.h)}`, body: fill(NEWS.listing.acquire.b), symbols: [a.sym] });
    } else if (r < cfg.rescueOdds[0] + cfg.rescueOdds[1]) { // 유상증자: 주식 수가 늘어 시총은 회복, 가격은 희석
      const added = uni(1.5, 3);
      if (a.shares) a.shares *= added;
      const move = -uni(0.1, 0.25);
      a.anchor *= Math.exp(move);
      react(a.pending, move);
      publish({ kind: "신흥주", headline: `${a.name}(${a.sym}) · ${fill(NEWS.listing.raise.h)}`, body: fill(NEWS.listing.raise.b), symbols: [a.sym] });
    } // 나머지는 소식 없음: 스스로 회복해야 한다
  }
  function endWatch(a: AssetState) {
    a.watchUntil = null;
    if ((capOf(a) ?? 0) >= cfg.delistCap) {
      a.stage = null;
      const fill = fillOf(a);
      publish({ kind: "신흥주", headline: `${a.name}(${a.sym}) · ${fill(NEWS.listing.release.h)}`, body: fill(NEWS.listing.release.b), symbols: [a.sym] });
    } else delist(a);
  }

  function reviewListings() {
    const newGrowth = () => live().filter(x => x.sector === "newgrowth").length;
    for (const a of live()) {
      if (a.market !== "venture" || venturesBusy.has(a.sym)) continue;
      if (a.price < cfg.splitPrice) reverseSplit(a);
      const cap = capOf(a) ?? 0;
      if (a.watchUntil != null) { if (tick >= a.watchUntil) endWatch(a); continue; }
      const gradOpen = tick >= nextGradAt && newGrowth() < cfg.maxNewGrowth;
      if (gradOpen && a.successes >= cfg.gradSuccesses && cap >= cfg.gradCap) graduate(a);
      else if (cap < cfg.delistCap) designate(a);
    }
  }
  function listNew() {
    const i = sparePool.findIndex(d => !state[d.sym]);
    if (i < 0) { scheduled.push({ at: tick + 300, kind: "list" }); return; } // 예비 종목이 없으면 나중에 다시
    const [d] = sparePool.splice(i, 1), price = Math.round(uni(2, 10) * 100) / 100;
    addAsset({ ...d, market: "venture", sector: "venture", price, cap: price * Math.round(uni(5e7, 2e8)), parValue: d.parValue ?? 0.1 });
    const a = state[d.sym], fill = fillOf(a);
    a.bars.push({ timestamp: barTime(), open: price, high: price, low: price, close: price, volume: 0 });
    actions.push({ type: "list", sym: a.sym });
    publish({ kind: "신흥주", headline: `${a.name}(${a.sym}) · ${fill(NEWS.listing.ipo.h)}`, body: fill(NEWS.listing.ipo.b), symbols: [a.sym] });
  }
  // ---------- 가격 ----------
  function updateBarStats(a: AssetState) {
    const ch = a.price - a.lastClose, p = cfg.rsiPeriod;
    a.avgGain = (a.avgGain * (p - 1) + Math.max(ch, 0)) / p;
    a.avgLoss = (a.avgLoss * (p - 1) + Math.max(-ch, 0)) / p;
    a.rsi = a.avgLoss === 0 ? 100 : 100 - 100 / (1 + a.avgGain / a.avgLoss);
    a.lastClose = a.price;
    const recent = a.bars.slice(-cfg.srLookback);
    if (recent.length >= 20) {
      let hi = -Infinity, lo = Infinity;
      for (const b of recent) { if (b.high > hi) hi = b.high; if (b.low < lo) lo = b.low; }
      a.hi = hi; a.lo = lo;
    }
  }
  // 전고점·전저점·라운드 넘버 근처에서 머뭇거림. 위에 있는 선은 저항(아래로), 아래 선은 지지(위로)
  function srTilt(a: AssetState): number {
    const step = 10 ** Math.floor(Math.log10(a.price)) / 2;
    const levels = [a.hi, a.lo, Math.ceil(a.price / step) * step, Math.floor(a.price / step) * step];
    let t = 0;
    for (const L of levels) {
      if (!L) continue;
      const d = Math.log(L / a.price);
      if (d > 0 && d < cfg.srBand) t -= 1 - d / cfg.srBand;
      else if (d < 0 && -d < cfg.srBand) t += 1 + d / cfg.srBand;
    }
    return Math.max(-1, Math.min(1, t)) * cfg.srWeight * a.sigma;
  }
  // 전고점 돌파·전저점 이탈: 거래량 급증 + 같은 방향으로 한 번 더 밀어줌 (봉당 1회)
  function checkBreak(a: AssetState, before: number, barIndex: number) {
    if (a.hi == null || a.lo == null || a.breakBar === barIndex) return;
    const up = before <= a.hi && a.price > a.hi * (1 + cfg.srBand / 2);
    const down = before >= a.lo && a.price < a.lo * (1 - cfg.srBand / 2);
    if (!up && !down) return;
    react(a.pending, (up ? 1 : -1) * a.sigma * uni(4, 9));
    a.volBoost = 10; a.breakBar = barIndex;
  }

  function step(): StepResult {
    tick++;
    actions = [];
    const before = news.length ? news[0].id : null, versionBefore = assetsVersion;
    for (let j = scheduled.length - 1; j >= 0; j--) if (scheduled[j].at <= tick) runTask(scheduled.splice(j, 1)[0]);
    if (tick >= nextNewsAt) { makeNews(); nextNewsAt = tick + Math.round(uni(...cfg.newsGap)); }

    const m = gauss() * cfg.marketSigma + drain(marketPending);
    const sec: Record<string, number> = {};
    for (const k in sectorPending) sec[k] = gauss() * cfg.sectorSigma + drain(sectorPending[k]);
    const barIndex = Math.floor((tick - 1) / cfg.ticksPerBar);
    const barStart = (tick - 1) % cfg.ticksPerBar === 0, barEnd = tick % cfg.ticksPerBar === 0;

    for (const a of live()) {
      if (rand() < cfg.regimeSwitch) a.regime = a.regime === "range" ? "trend" : "range";
      if (a.eps && a.baseEps) {
        a.eps *= Math.exp((-Math.LN2 / cfg.epsHalfLife) * Math.log(a.eps / a.baseEps));
        a.eps = Math.min(a.baseEps * cfg.epsBand[1], Math.max(a.baseEps * cfg.epsBand[0], a.eps));
      }
      const fair = a.eps && a.fairPER ? a.eps * a.fairPER : a.anchor;
      const pull = -cfg.kappa * (a.market === "coin" ? 0.3 : 1) * Math.log(a.price / fair);
      // 박스권: 과매수면 하락 쪽으로, 추세장: 강한 쪽으로 약하게
      const rsiTilt = ((a.rsi - 50) / 50) * cfg.rsiWeight * a.sigma * (a.regime === "range" ? -1 : 0.5);
      const shock = drain(a.pending);
      const noise = gauss() * a.sigma * Math.sqrt(a.variance);
      let r = a.betaM * m + a.betaS * (sec[a.sector] || 0) + noise + pull + rsiTilt + srTilt(a) + shock;
      if (a.jump && rand() < a.jump) r += gauss() * a.sigma * 6;
      const open = a.price;
      a.price = Math.max(0.01, a.price * Math.exp(r));
      const z = noise / a.sigma;
      a.variance = Math.min(4, Math.max(0.5, 0.97 * a.variance + 0.03 * (z * z + (shock / a.sigma) ** 2)));
      checkBreak(a, open, barIndex);

      const vol = Math.round(uni(40, 160) * (1 + Math.abs(r) / a.sigma) * (a.volBoost-- > 0 ? 3 : 1));
      const last = a.bars[a.bars.length - 1];
      if (barStart || !last) {
        a.bars.push({ timestamp: barTime(), open, high: Math.max(open, a.price), low: Math.min(open, a.price), close: a.price, volume: vol });
        if (a.bars.length > cfg.maxBars) a.bars.splice(0, a.bars.length - cfg.maxBars);
      } else {
        last.high = Math.max(last.high, a.price); last.low = Math.min(last.low, a.price); last.close = a.price; last.volume += vol;
      }
      if (barEnd) updateBarStats(a);
    }
    if (tick % cfg.ticksPerDay === 0) {
      for (const a of live()) a.prev = a.price;
      if (!warm) reviewListings();
    }
    const published: NewsItem[] = [];
    for (const n of news) { if (n.id === before) break; published.push(n); }
    return { news: published, barClosed: barEnd, assetsChanged: assetsVersion !== versionBefore, actions };
  }

  // 시작 가격 맞추기: 과거 차트를 먼저 만든 뒤 전체를 비율로 늘이거나 줄여 마지막 가격 = 설정한 시작가.
  // 그리고 시작가를 적정가로 다시 잡는다 (주식 EPS = 가격 / 적정 PER, 그 외 앵커 = 가격).
  function rebase() {
    for (const a of live()) {
      const k = a.def.price / a.price;
      for (const b of a.bars) { b.open *= k; b.high *= k; b.low *= k; b.close *= k; }
      a.price *= k; a.prev *= k; a.lastClose *= k; a.avgGain *= k; a.avgLoss *= k;
      if (a.hi != null) a.hi *= k;
      if (a.lo != null) a.lo *= k;
      for (const n of news) if (n.priceAt[a.sym]) n.priceAt[a.sym] *= k;
      if (a.market === "stock" && a.fairPER) a.eps = a.baseEps = a.price / a.fairPER; else a.anchor = a.price;
      a.successes = 0;
      if (!venturesBusy.has(a.sym)) a.stage = null;
    }
    warm = false;
    nextGradAt = tick + Math.round((cfg.gradCooldown / 2) * uni(0.7, 1.3));
  }

  // 스냅샷: 엔진의 모든 상태를 JSON 하나로. 서버 재시작 때 처음부터 재생하지 않고 이어서 돌린다
  function takeSnapshot(): string {
    return JSON.stringify({
      v: SNAPSHOT_VERSION, rng: rng.get(), tick, nextNewsAt, warm, assetsVersion,
      nextGradAt: Number.isFinite(nextGradAt) ? nextGradAt : null, startTime, news, scheduled,
      marketPending, sectorPending, venturesBusy: [...venturesBusy], sparePool, state,
    });
  }
  function restore(json: string) {
    const d = JSON.parse(json);
    if (d.v !== SNAPSHOT_VERSION) throw new Error(`스냅샷 버전이 다릅니다: ${d.v}`);
    rng.set(d.rng); tick = d.tick; nextNewsAt = d.nextNewsAt; warm = d.warm; assetsVersion = d.assetsVersion;
    nextGradAt = d.nextGradAt ?? Infinity; startTime = d.startTime; news = d.news; scheduled = d.scheduled;
    marketPending = d.marketPending; sectorPending = d.sectorPending; venturesBusy = new Set(d.venturesBusy);
    sparePool = d.sparePool; state = d.state;
  }

  if (snapshot) restore(snapshot);
  else {
    for (let i = 0; i < cfg.warmupBars * cfg.ticksPerBar; i++) step();
    rebase();
  }

  function liquidity(a: AssetState): number {
    const cap = capOf(a) ?? 0;
    if (a.market === "stock") return Math.max(5e6, cap * 1e-5);
    if (a.market === "coin") return a.def.liquidity ?? 2e7;
    return Math.max(5e5, cap * 2e-3);
  }
  // 제곱근 충격: 4배 큰 주문은 2배만 더 움직인다. 체결가는 충격의 절반 지점(주문하는 사람도 자기 충격을 맞는다)
  function applyFlow(sym: string, notional: number) {
    const a = state[sym];
    if (!a) return null;
    if (!notional) return { price: a.price, impact: 0 };
    const sign = Math.sign(notional);
    const sigmaDay = a.sigma * Math.sqrt(cfg.ticksPerDay);
    const impact = Math.min(cfg.impactK * sigmaDay * Math.sqrt(Math.abs(notional) / liquidity(a)), cfg.impactCap[a.market]);
    const pre = a.price;
    a.price = pre * Math.exp(sign * impact);
    const permanent = sign * impact * (1 - cfg.impactTempShare);
    if (a.eps && a.baseEps) a.eps *= Math.exp(permanent); else a.anchor *= Math.exp(permanent);
    impulse(a.pending, -sign * impact * cfg.impactTempShare, cfg.impactRevertTicks); // n을 넘겨 난수를 쓰지 않는다 (재현성)
    const last = a.bars[a.bars.length - 1];
    if (last) { last.high = Math.max(last.high, a.price); last.low = Math.min(last.low, a.price); last.close = a.price; }
    return { price: pre * Math.exp((sign * impact) / 2), impact };
  }

  const toQuote = (a: AssetState): Quote => ({
    sym: a.sym, name: a.name, market: a.market, sector: a.sector, price: a.price, prev: a.prev,
    per: a.eps ? a.price / a.eps : null, cap: capOf(a), stage: a.stage, parValue: a.par, splitFactor: a.splitFactor,
  });

  return {
    options: cfg,
    get tick() { return tick; },
    get assetsVersion() { return assetsVersion; },
    get news() { return news; },
    step,
    gameDate: () => gameDate(),
    quotes: () => live().map(toQuote),
    quote: sym => (state[sym] ? toQuote(state[sym]) : null),
    bars: sym => state[sym]?.bars ?? [],
    liquidity: sym => (state[sym] ? liquidity(state[sym]) : null),
    snapshot: takeSnapshot,
    applyFlow,
  };
}
