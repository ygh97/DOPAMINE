// 도파민 센터 시세 엔진. 서버 GameLoop가 1초마다 step()을 부른다.
//
// 엔진 가격은 화면에 안 나오는 기준가다. 호가창(exchange.ts)의 호가 봇이 이 근처에 호가를 깔고, 화면 가격은 체결가다.
// 틱 수익률 r = 시즌 성장 + 시장 요인 × 베타 + 업종 요인 × 업종 베타 + 개별 노이즈 × 변동성 군집
//             + 뉴스 반응(즉시 → 따라붙음 → 과열 되돌림) + 적정가 회귀 + RSI 기울기(국면에 따라 역추세/추세) + 지지·저항 + 점프
// 뉴스: 시장·업종·기업·코인·신흥주 검증·연쇄·루머·공시·고래 지갑·밈, 예고 뒤 발표(지표·실적·신제품·ETF), 애널리스트 리포트(채점)
// 세력 패턴(개미털기·스퀴즈·설거지·스탑헌팅)은 엔진이 아니라 🏦 세력 계좌가 실제 주문으로 만든다 (apps/server/src/bots.ts).
// 숨은 상태(대기 충격, 국면, 앵커, EPS)는 이 모듈 밖으로 나가지 않는다. 밖으로는 Quote·Bar·NewsItem만.
import { ANALYSTS, NEWS, RELATED, type Template } from "./news-templates.ts";
import type { AnalystStat, AnalystView, AssetDef, Bar, Consensus, CorporateAction, GameDate, MarketKind, MarketOptions, NewsItem, Opinion, Quote, SpareDef, StepResult, Upcoming } from "./types.ts";

export const DEFAULT_OPTIONS: MarketOptions = {
  ticksPerBar: 60,        // 1분봉 = 60틱(1초 tick)
  ticksPerDay: 80,        // 게임 하루 (실적·심사·등락률 같은 규칙의 하루)
  calendarDayTicks: 0,    // 화면 달력의 하루 (0이면 ticksPerDay). 서버가 시즌 하나 = 달력 1년이 되게 넣는다. 규칙에는 안 쓴다
  prevResetDays: 1,       // 등락률 기준가(prev) 초기화 주기 = 게임 하루(80틱)
  seasonGrowth: [1.5, 3], // 우상향은 여기서만 만든다: 시즌 동안 적정가가 1.5~3배 (시즌마다 하나를 뽑음)
  seasonTicks: 28_800,    // 시즌 = 게임 1년 (360일 × 80틱 = 실제 8시간)
  barMs: 60_000,
  warmupBars: 720,        // 시작 전 과거 차트
  maxBars: 1500,
  newsGap: [6, 14],       // 뉴스 간격(틱)
  marketSigma: 0.0007,
  sectorSigma: 0.0018,    // 같은 업종(섹터·코인)끼리 주가 방향이 강하게 묶이도록 상향
  kappa: 0.0004,          // 적정가 회귀 강도 (반감기 약 1,700틱 ≈ 30분, M7까지 0.0006). 안전장치 몫만 남기고 나머지는 가치투자 세력이 당긴다 (A14, sim:bots로 보정)
  rsiPeriod: 14,
  rsiWeight: 0.25,        // RSI 기울기 최대치 = 개별 σ의 25%
  regimeSwitch: 1 / 400,  // 국면 전환 확률(틱당)
  flipChance: 0.08,       // 뉴스 반응이 반대로 나올 확률 (호재 반응 일관성 강화)
  followChance: 0.6,      // 뉴스 첫 반응 뒤 같은 방향으로 따라붙을 확률. 나머지는 재료 소진으로 일부 되돌림
  srLookback: 60,         // 전고점·전저점을 볼 봉 수
  srBand: 0.004,          // 지지·저항이 작동하는 거리 (0.4%)
  srWeight: 0.35,         // 지지·저항 기울기 최대치 = 개별 σ의 35%
  gradCap: 3e9,           // 신흥주 → 주식 승격: 검증 성공 gradSuccesses회 이상 + 시총 30억 달러
  gradSuccesses: 2,
  gradCooldown: 0,        // 승격 사이 평균 간격(±30%). 0이면 시즌 ÷ (maxNewGrowth + 1) → 시즌 동안 고르게 퍼진다. 첫 승격은 그 절반 뒤
  gradPER: 15,
  splitPrice: 0.1,        // 신흥주 가격이 $0.10 아래면 주식병합(10:1)
  delistCap: 5e7,         // 시총 5천만 달러 아래면 관리종목 → 유예 기간 뒤에도 미달이면 상장폐지
  watchTicks: 2400,       // 관리종목 유예 기간 (게임 30일 = 40분)
  rescueOdds: [0.3, 0.3], // 유예 중 회생 이벤트 확률: [인수 제안, 유상증자], 나머지는 소식 없음
  maxNewGrowth: 10,       // 신성장(승격 종목) 최대 개수. 다 차면 더 승격하지 않는다
  ventureCap: 300,        // 신흥주 소프트 상한: 시작가 대비 이 배수에 가까울수록 검증 성공 상승폭이 줄어든다 (100배 전설 보정으로 100 → 300)
  ventureSuccess: 0.85,   // 신흥주 검증 성공 확률 (졸업률 보정용, tools/sim-bots.ts. 2026-10-22 보정: 100배 전설 평균 3% 이상 → 약 3.5%)
  epsHalfLife: 172_800,   // EPS가 기준값으로 돌아가는 반감기(틱, 2일)
  epsBand: [0.4, 3],      // EPS(= 적정가)는 기준의 0.4~3배 안에서만 움직인다
  // 호가창 두께와 순매수의 영구 몫: 충격 = impactK × σ_일 × √(명목 금액 / 가상 유동성). 호가 봇이 같은 크기로 호가를 깐다
  impactK: 2,
  impactCap: { stock: 0.03, coin: 0.05, venture: 0.15 }, // tick당 충격 상한
  impactTempShare: 0.7,   // 충격 중 사라지는 몫(호가 봇 재고 헤지가 맡음). 나머지 30%는 기준가·적정가에 남는다
};

const KIND: Record<MarketKind, { sigma: number; betaM: number; betaS: number; jump: number }> = {
  stock: { sigma: 0.00085, betaM: 1.0, betaS: 1.45, jump: 0 },
  coin: { sigma: 0.00095, betaM: 0.75, betaS: 2.15, jump: 0 },
  venture: { sigma: 0.0032, betaM: 0.5, betaS: 0.9, jump: 0.002 },
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
  dev: number; // 주식 외 종목의 적정가 이탈(로그). 뉴스·세력이 움직이고 EPS처럼 기준으로 돌아간다
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
  /** 종목의 틱당 기본 변동성 σ (호가창 스프레드·간격 계산용) */
  sigma(sym: string): number | null;
  /**
   * 호가창(Exchange)에서 실제 체결된 순매수 금액을 기준가에 남긴다. 충격 중 영구 몫(30%)만 기준가와 적정가를 옮긴다.
   * 사라지는 몫은 호가 봇 재고 헤지가 맡는다. tick이 끝날 때(다음 step() 전) 종목마다 한 번 부른다.
   */
  absorbFlow(sym: string, notional: number): void;
  /** 예고된 일정 (지표 발표·실적·신제품 행사·ETF 심사). 결과는 들어 있지 않다 */
  upcoming(): Upcoming[];
  /** 애널리스트 적중률과 최근 리포트 (성향은 숨김) */
  analysts(): AnalystView[];
  /** 종목별 최근(한 분기 안) 애널리스트 의견 분포와 평균 목표가 */
  consensus(sym: string): Consensus;
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
/** title이 있는 일은 예고된 일정이라 upcoming()으로 공개한다 (결과는 숨김) */
type Task =
  | { at: number; kind: "venture1" | "venture2"; sym: string; success: boolean; eventId: string }
  | { at: number; kind: "list" }
  | { at: number; kind: "rescue"; sym: string }
  | { at: number; kind: "macro"; idx: number; outcome: "good" | "bad" | "flat"; eventId: string; title: string; sym: null }
  | { at: number; kind: "earnings"; sym: string; title: string }
  | { at: number; kind: "launch"; sym: string; outcome: "good" | "sellNews" | "bad"; eventId: string; title: string }
  | { at: number; kind: "etf"; sym: string; approve: boolean; eventId: string; title: string }
  | { at: number; kind: "rumor"; sym: string; confirm: boolean; pre: number; eventId: string }
  | { at: number; kind: "memeDump"; sym: string; size: number }
  | { at: number; kind: "score"; analyst: string; rid: string; sym: string; opinion: Opinion; price0: number };
const SNAPSHOT_VERSION = 1;

export function createMarket({ assets, sectors, spares = [], seed = 20261021, now = Date.now(), options = {}, snapshot }: CreateMarketInput): Market {
  const merged: MarketOptions = { ...DEFAULT_OPTIONS, ...options };
  const cfg: MarketOptions = { ...merged, gradCooldown: merged.gradCooldown || Math.round(merged.seasonTicks / (merged.maxNewGrowth + 1)) };
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
      anchor: def.price, dev: 0,
      shares: def.cap ? def.cap / def.price : null,
      variance: 1, regime: rand() < 0.5 ? "range" : "trend",
      pending: [], bars: [], rsi: 50, avgGain: 0, avgLoss: 0, lastClose: def.price,
      hi: null, lo: null, volBoost: 0, successes: 0, stage: null, watchUntil: null,
      par: def.parValue ?? null, splitFactor: 1,
    };
    assetsVersion++;
  }
  assets.forEach(addAsset);
  for (const k in sectors) sectorPending[k] ??= [];
  // 틱당 적정가 성장률 (로그). 시즌마다 seasonGrowth 안에서 하나
  let drift = Math.log(uni(...cfg.seasonGrowth)) / cfg.seasonTicks;

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
  // 뉴스 반응 모양: 즉시 45~80% → followChance면 나머지가 따라붙고(+ 과열 후 되돌림), 아니면 재료 소진으로 일부 되돌린다.
  // 첫 반응 뒤 방향을 알 수 없어야 "뉴스 보고 따라 타기"가 확정 수익이 되지 않는다 (tools/sim-bots.ts로 확인)
  function react(list: Impulse[], total: number) {
    const now = uni(0.45, 0.8);
    impulse(list, total * now, Math.round(uni(3, 8)));
    if (rand() < cfg.followChance) {
      const over = rand() < 0.6 ? uni(0.1, 0.5) : 0;
      impulse(list, total * (1 - now + over), Math.round(uni(20, 40)), 3);
      if (over) impulse(list, -total * over, Math.round(uni(30, 60)), Math.round(uni(45, 75)));
    } else {
      impulse(list, -total * now * uni(0.15, 0.5), Math.round(uni(15, 35)), 3);
    }
  }
  // 의도한 충격 → 실제 반영량 (0.3~1.5배, 가끔 반대)
  const realize = (intended: number, flip = cfg.flipChance) => intended * uni(0.3, 1.5) * (rand() < flip ? -1 : 1);

  // ---------- 시간 ----------
  // 시즌 달력은 과거 차트(warmup)가 끝난 시점부터 1년차 1월 1일. 그 전은 year 0 = "시즌 전"
  const seasonStartTick = cfg.warmupBars * cfg.ticksPerBar;
  const gameDate = (t = tick): GameDate => {
    const d = Math.floor((t - seasonStartTick) / (cfg.calendarDayTicks || cfg.ticksPerDay));
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

  // 적정가 이동: 뉴스·세력은 기준(baseEps·anchor)이 아니라 이탈분(eps·dev)만 움직인다.
  // 이탈분은 epsBand 안에서만 움직이고 epsHalfLife로 기준에 돌아간다. 기준을 올리는 건 drift뿐 (안 그러면 복리로 폭주)
  const devBand = [Math.log(cfg.epsBand[0]), Math.log(cfg.epsBand[1])];
  function shiftFair(a: AssetState, logMove: number) {
    if (a.eps != null && a.baseEps != null) {
      a.eps = Math.min(a.baseEps * cfg.epsBand[1], Math.max(a.baseEps * cfg.epsBand[0], a.eps * Math.exp(logMove)));
    } else {
      a.dev = Math.min(devBand[1], Math.max(devBand[0], a.dev + logMove));
    }
  }

  // ---------- 뉴스 ----------
  // 호재 빈도 × 크기 × (1 - 2×선반영) ≈ 악재 빈도 × 크기라 뉴스의 기대값은 0 근처. 시즌 우상향은 drift가 만든다
  const FAIR_SHARE = 0.3; // 뉴스 충격 중 적정가에 남는 몫 (호재·악재 같은 비율)
  const PRICED_IN = 0.2;  // 호재인데 "재료 소멸"로 반대로 움직일 확률
  const MIN = 60;         // 1분 = 60 tick (예고 뉴스의 "N분 뒤")
  const QUARTER = 90 * cfg.ticksPerDay; // 게임 분기 = 90일 (실적 시즌)
  /** 문구 채우기: 종목 자리표시 + 넘겨준 값({pct} {n} {amount} {peers} {firm} {analyst} {target}). 남은 {n}은 작은 정수 */
  function render(s: string, a: AssetState | null, v: Record<string, string | number> = {}) {
    let out = a ? fillOf(a)(s) : s;
    for (const [k, val] of Object.entries(v)) out = out.replaceAll(`{${k}}`, String(val));
    return out.replaceAll("{n}", String(Math.round(uni(2, 9))));
  }
  /** 움직임 크기 → 문구 속 숫자 (예: 0.034 → 3). 문구의 숫자가 실제 움직임과 맞게 */
  const pctOf = (move: number, k = 100) => Math.max(1, Math.round(Math.abs(move) * k));
  const amountOf = (a: AssetState) => `${Math.max(1, Math.round(((capOf(a) ?? 5e10) * uni(0.001, 0.005)) / 1e8))}억 달러`;
  const money = (v: number) => "$" + (v >= 1000 ? Math.round(v).toLocaleString("en-US") : v.toFixed(v < 1 ? 4 : 2));
  const fairOf = (a: AssetState) => (a.eps && a.fairPER ? a.eps * a.fairPER : a.anchor * Math.exp(a.dev));
  /** 종목 하나에 반응을 주고 적정가에 share만큼 남긴다 */
  function hitAsset(a: AssetState, move: number, share = FAIR_SHARE, boost = 10) {
    react(a.pending, move);
    if (share) shiftFair(a, move * share);
    a.volBoost = Math.max(a.volBoost, boost);
  }
  const stocks = () => live().filter(x => x.market === "stock");
  const coins = () => live().filter(x => x.market === "coin");

  function marketNews() {
    const good = rand() < 0.80, tpl = pick(good ? NEWS.market.good : NEWS.market.bad);
    const move = good ? realize(uni(0.006, 0.016), PRICED_IN) : realize(-uni(0.02, 0.043), 0.08);
    react(marketPending, move);
    for (const a of live()) shiftFair(a, move * a.betaM * FAIR_SHARE);
    publish({ kind: "시장", headline: render(tpl.h, null, { pct: pctOf(move, 10) / 10 }), body: render(tpl.b, null), symbols: [] });
  }
  function sectorNews() {
    const members = (key: string) => live().filter(a => a.sector === key).map(a => a.sym);
    const key = pick(Object.keys(sectors).filter(k => k !== "venture" && members(k).length)), name = sectors[key];
    const good = rand() < 0.80, only = NEWS.sectorOnly[key];
    const tpl = pick([...(good ? NEWS.sector.good : NEWS.sector.bad), ...(only ? (good ? only.good : only.bad) : [])]);
    const move = good ? realize(uni(0.01, 0.026), PRICED_IN) : realize(-uni(0.033, 0.07), 0.08);
    react(sectorPending[key], move);
    for (const a of live()) {
      if (a.sector === key) shiftFair(a, move * a.betaS * FAIR_SHARE);
    }
    const v = { sector: name, pct: pctOf(move, 300) };
    publish({ kind: "업종", sector: key, headline: `${name} 업종 · ${render(tpl.h, null, v)}`, body: render(tpl.b, null, v), symbols: members(key) });
  }
  function companyNews() {
    const a = pick(live().filter(x => x.market !== "venture"));
    const good = rand() < 0.82, src = a.market === "coin" ? NEWS.coin : NEWS.company;
    const tpl: Template = pick(good ? src.good : src.bad);
    // 개별 회사·코인 뉴스는 그 종목에 반응한다 (관련주는 연쇄 뉴스로). 실적 관련 뉴스는 적정가에 더 많이 남는다
    const rawMag = a.market === "coin"
      ? (good ? uni(0.035, 0.09) : -uni(0.12, 0.29))
      : (good ? uni(0.02, 0.06) : -uni(0.08, 0.18));
    const move = realize(rawMag, good ? PRICED_IN : 0.08);
    hitAsset(a, move, tpl.eps ? 2 * FAIR_SHARE : FAIR_SHARE, good ? 14 : 8);
    publish({ kind: a.market === "coin" ? "코인" : "기업", headline: `${a.name} · ${render(tpl.h, a, { pct: pctOf(move) })}`, body: render(tpl.b, a, { pct: pctOf(move) }), symbols: [a.sym] });
    chain(a, move);
  }
  /** 연쇄: 관련주(peers)는 같은 방향으로 25~45%, 호재면 경쟁사(rivals)가 반대로 15~30% 움직인다 */
  function chain(a: AssetState, move: number) {
    const rel = RELATED[a.sym];
    if (!rel || rand() >= 0.4) return;
    const rivals = move > 0 && rand() < 0.5 ? (rel.rivals ?? []).map(s => state[s]).filter(Boolean) : [];
    const hit = rivals.length ? rivals : rel.peers.map(s => state[s]).filter(Boolean);
    if (!hit.length) return;
    const k = rivals.length ? -uni(0.15, 0.3) : uni(0.25, 0.45);
    for (const p of hit) hitAsset(p, move * k);
    const tpl = rivals.length ? NEWS.chain.bad[1] : move > 0 ? pick(NEWS.chain.good) : NEWS.chain.bad[0];
    const v = { peers: hit.map(p => p.name).join("·") };
    publish({ kind: "연쇄", headline: render(tpl.h, a, v), body: render(tpl.b, a, v), symbols: [a.sym, ...hit.map(p => p.sym)] });
  }
  // 신흥주 3단계 검증: 최초 주장 → 재현 시험 → 성공/실패 (성공 확률 ventureSuccess)
  function ventureEvent() {
    const free = live().filter(a => a.market === "venture" && !venturesBusy.has(a.sym) && a.watchUntil == null);
    if (!free.length) return companyNews();
    const a = pick(free), success = rand() < cfg.ventureSuccess, eventId = nid();
    venturesBusy.add(a.sym);
    react(a.pending, realize(uni(0.06, 0.18), 0.03));
    a.stage = "기술검증";
    ventureStage(a, 0, success, eventId, pick(NEWS.venture[0]));
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

  // ----- 예고가 있는 뉴스: 지표 · 실적 · 신제품 행사 · ETF 심사 (결과는 예고 때 정해 두고 숨긴다. 일정은 upcoming()으로 공개) -----
  function macroAnnounce() {
    if (scheduled.some(t => t.kind === "macro")) return noiseNews();
    const idx = Math.floor(rand() * NEWS.macro.length), m = NEWS.macro[idx], mins = Math.round(uni(3, 8)), r = rand();
    const outcome = r < 0.4 ? "good" : r < 0.7 ? "bad" : "flat", eventId = nid();
    scheduled.push({ at: tick + mins * MIN, kind: "macro", idx, outcome, eventId, title: `${m.name} 발표`, sym: null });
    publish({ kind: "지표", headline: render(m.pre.h, null, { n: mins }), body: m.pre.b, symbols: [], event: { id: eventId, index: 0, total: 2, label: "예고" } });
  }
  function macroResult(t: Extract<Task, { kind: "macro" }>) {
    const m = NEWS.macro[t.idx];
    // 좋음 40% × 0.8~2% ≈ 나쁨 30% × 1.25~2.5% → 기대값 0 근처
    const move = t.outcome === "good" ? uni(0.008, 0.02) : t.outcome === "bad" ? -uni(0.0125, 0.025) : gauss() * 0.002;
    react(marketPending, move);
    for (const a of live()) shiftFair(a, move * a.betaM * FAIR_SHARE);
    const tpl = pick(m[t.outcome]);
    publish({ kind: "지표", headline: render(tpl.h, null, { pct: pctOf(move, 300) }), body: tpl.b, symbols: [], event: { id: t.eventId, index: 1, total: 2, label: "발표" } });
  }
  /** 실적 시즌: 분기가 시작되면 주식마다 발표 시각을 정해 일정에 올린다 */
  function earningsSeason() {
    const list = stocks();
    for (const a of list) scheduled.push({ at: tick + Math.round(uni(5 * MIN, QUARTER - 5 * MIN)), kind: "earnings", sym: a.sym, title: `${a.name}(${a.sym}) 실적 발표` });
    publish({ kind: "실적", headline: render(NEWS.earnings.season.h, null, { n: list.length }), body: NEWS.earnings.season.b, symbols: [] });
  }
  function earningsResult(sym: string) {
    const a = state[sym];
    if (!a || a.market !== "stock") return;
    // 깜짝 실적 60% × 3~20% ≈ 쇼크 40% × 5~30%. 주가는 서프라이즈의 40%만큼, 적정가에 2배로 남는다
    const good = rand() < 0.6, surprise = good ? uni(3, 20) : uni(5, 30), move = (good ? 1 : -1) * surprise / 100 * 0.4;
    hitAsset(a, move, 2 * FAIR_SHARE, 16);
    const tpl = pick(good ? NEWS.earnings.good : NEWS.earnings.bad), v = { pct: Math.round(surprise) };
    publish({ kind: "실적", headline: render(tpl.h, a, v), body: render(tpl.b, a, v), symbols: [a.sym] });
    chain(a, move);
  }
  function launchAnnounce() {
    const busy = new Set(scheduled.flatMap(t => (t.kind === "launch" ? [t.sym] : [])));
    const a = pick(stocks().filter(x => !busy.has(x.sym)));
    if (!a) return noiseNews();
    const mins = Math.round(uni(4, 10)), r = rand(), outcome = r < 0.35 ? "good" : r < 0.8 ? "sellNews" : "bad", eventId = nid();
    impulse(a.pending, uni(0.01, 0.03), Math.round(mins * MIN * 0.8)); // 기대감에 미리 오른다
    scheduled.push({ at: tick + mins * MIN, kind: "launch", sym: a.sym, outcome, eventId, title: `${a.name}(${a.sym}) 신제품 공개` });
    const tpl = pick(NEWS.launch.pre);
    publish({ kind: "행사", headline: render(tpl.h, a, { n: mins }), body: render(tpl.b, a), symbols: [a.sym], event: { id: eventId, index: 0, total: 2, label: "예고" } });
  }
  function launchResult(t: Extract<Task, { kind: "launch" }>) {
    const a = state[t.sym];
    if (!a) return;
    const move = t.outcome === "good" ? uni(0.03, 0.07) : t.outcome === "sellNews" ? -uni(0.02, 0.05) : -uni(0.05, 0.1);
    hitAsset(a, move, t.outcome === "sellNews" ? 0 : FAIR_SHARE, 14);
    const tpl = pick(NEWS.launch[t.outcome]);
    publish({ kind: "행사", headline: render(tpl.h, a), body: render(tpl.b, a), symbols: [a.sym], event: { id: t.eventId, index: 1, total: 2, label: "공개" } });
  }
  function etfAnnounce() {
    if (scheduled.some(t => t.kind === "etf")) return whaleNews();
    const a = pick(coins());
    if (!a) return noiseNews();
    const mins = Math.round(uni(5, 10)), approve = rand() < 0.45, eventId = nid();
    impulse(a.pending, uni(0.01, 0.03), Math.round(mins * MIN * 0.8));
    scheduled.push({ at: tick + mins * MIN, kind: "etf", sym: a.sym, approve, eventId, title: `${a.name}(${a.sym}) 현물 ETF 심사 결과` });
    const tpl = pick(NEWS.etf.pre);
    publish({ kind: "코인", headline: render(tpl.h, a, { n: mins }), body: render(tpl.b, a), symbols: [a.sym], event: { id: eventId, index: 0, total: 2, label: "예고" } });
  }
  function etfResult(t: Extract<Task, { kind: "etf" }>) {
    const a = state[t.sym];
    if (!a) return;
    const move = t.approve ? uni(0.08, 0.18) : -uni(0.05, 0.12);
    hitAsset(a, move, t.approve ? FAIR_SHARE : 0, 16);
    const tpl = pick(t.approve ? NEWS.etf.good : NEWS.etf.bad);
    publish({ kind: "코인", headline: render(tpl.h, a), body: render(tpl.b, a), symbols: [a.sym], event: { id: t.eventId, index: 1, total: 2, label: t.approve ? "승인" : "연기" } });
  }

  // ----- 예고 없는 새 뉴스: 루머 · 공시 · 고래 지갑 · 커뮤니티 밈 -----
  function rumorNews() {
    const a = pick(stocks());
    if (!a) return noiseNews();
    const pre = uni(0.02, 0.05), confirm = rand() < 0.45, eventId = nid();
    hitAsset(a, pre, 0, 12);
    scheduled.push({ at: tick + Math.round(uni(3 * MIN, 8 * MIN)), kind: "rumor", sym: a.sym, confirm, pre, eventId });
    const tpl = pick(NEWS.rumor.pre);
    publish({ kind: "루머", headline: render(tpl.h, a), body: render(tpl.b, a), symbols: [a.sym], event: { id: eventId, index: 0, total: 2, label: "루머" } });
  }
  function rumorResult(t: Extract<Task, { kind: "rumor" }>) {
    const a = state[t.sym];
    if (!a) return;
    // 확인 45%: 4~10% 더 오르고 적정가에도 남는다. 부인: 루머로 오른 만큼(80~120%) 되돌림
    const move = t.confirm ? uni(0.04, 0.1) : -t.pre * uni(0.8, 1.2);
    hitAsset(a, move, t.confirm ? 2 * FAIR_SHARE : 0, 14);
    const tpl = pick(t.confirm ? NEWS.rumor.good : NEWS.rumor.bad);
    publish({ kind: "루머", headline: render(tpl.h, a), body: render(tpl.b, a), symbols: [a.sym], event: { id: t.eventId, index: 1, total: 2, label: t.confirm ? "확인" : "부인" } });
    if (t.confirm) chain(a, move);
  }
  function disclosureNews() {
    const a = pick(stocks());
    if (!a) return noiseNews();
    const tpl = pick(NEWS.disclosure), move = uni(0.01, 0.03);
    hitAsset(a, move, tpl.eps ? 2 * FAIR_SHARE : FAIR_SHARE);
    const v = { amount: amountOf(a), pct: Math.round(uni(5, 30)) };
    publish({ kind: "공시", headline: render(tpl.h, a, v), body: render(tpl.b, a, v), symbols: [a.sym] });
  }
  function whaleNews() {
    const a = pick(coins());
    if (!a) return noiseNews();
    const good = rand() < 0.5, move = (good ? 1 : -1) * uni(0.02, 0.06), tpl = pick(good ? NEWS.whale.good : NEWS.whale.bad);
    hitAsset(a, move, FAIR_SHARE / 2, 12);
    const v = { amount: amountOf(a) };
    publish({ kind: "코인", headline: render(tpl.h, a, v), body: render(tpl.b, a, v), symbols: [a.sym] });
  }
  function memeNews() {
    const a = pick(live().filter(x => x.market === "venture" && x.watchUntil == null && !venturesBusy.has(x.sym)));
    if (!a) return noiseNews();
    // 근거 없는 급등 15~40% → 2~5분 뒤 대부분(70~100%) 되돌림. 적정가는 안 움직인다
    const pump = uni(0.15, 0.4);
    impulse(a.pending, pump, Math.round(uni(20, 50)));
    a.volBoost = Math.max(a.volBoost, 20);
    scheduled.push({ at: tick + Math.round(uni(2 * MIN, 5 * MIN)), kind: "memeDump", sym: a.sym, size: pump * uni(0.7, 1) });
    const tpl = pick(NEWS.meme.pump);
    publish({ kind: "커뮤니티", headline: render(tpl.h, a), body: render(tpl.b, a), symbols: [a.sym] });
  }
  function memeDump(t: Extract<Task, { kind: "memeDump" }>) {
    const a = state[t.sym];
    if (!a) return;
    impulse(a.pending, -t.size, Math.round(uni(30, 90)));
    const tpl = pick(NEWS.meme.dump);
    publish({ kind: "커뮤니티", headline: render(tpl.h, a), body: render(tpl.b, a), symbols: [a.sym] });
  }

  // ----- 애널리스트 리포트: 성향마다 의견을 다르게 내고, 13분 뒤 맞았는지 채점한다 -----
  const SCORE_TICKS = 13 * MIN;
  const freshStats = (): Record<string, AnalystStat> => Object.fromEntries(ANALYSTS.map(x => [x.id, { hits: 0, total: 0, recent: [] }]));
  let stats = freshStats();
  function analystReport() {
    const an = pick(ANALYSTS), a = pick(live().filter(x => x.market !== "venture"));
    if (!a) return noiseNews();
    // look: 13분 동안 예상되는 움직임 = 남은 뉴스 반응(시장·업종·종목) + 적정가 쪽으로 당겨질 몫 + 시즌 성장, 오차 1%
    const price = a.price, left = (list: Impulse[]) => list.reduce((t, it) => t + it.total * it.w.slice(it.i).reduce((x, y) => x + y, 0), 0);
    const pull = 1 - Math.exp(-cfg.kappa * (a.market === "coin" ? 0.3 : 1) * SCORE_TICKS);
    const look = () => left(a.pending) + a.betaM * left(marketPending) + a.betaS * left(sectorPending[a.sector] ?? [])
      + pull * Math.log(fairOf(a) / price) + drift * SCORE_TICKS + gauss() * 0.01;
    let view: number;
    if (an.style === "accurate") view = look();
    else if (an.style === "contrarian") view = -look();
    else if (an.style === "optimist") view = uni(0.03, 0.15);
    else if (an.style === "pessimist") view = -uni(0.03, 0.15);
    else { const b = a.bars, past = b[Math.max(0, b.length - 16)]?.close ?? price; view = 1.5 * Math.log(price / past); }
    view = Math.max(-0.3, Math.min(0.3, view));
    const th = an.style === "accurate" || an.style === "contrarian" ? 0.005 : 0.015; // 정확형(과 그 반대)은 웬만하면 방향을 낸다
    const opinion: Opinion = view > th ? "매수" : view < -th ? "매도" : "중립", target = price * Math.exp(view);
    if (opinion !== "중립") hitAsset(a, (opinion === "매수" ? 1 : -1) * uni(0.003, 0.012), 0, 6); // 리포트에 조금 반응
    const tpl = pick(NEWS.report[opinion === "매수" ? "buy" : opinion === "매도" ? "sell" : "hold"]);
    const v = { firm: an.firm, analyst: an.name, target: money(target) };
    const item = publish({ kind: "리포트", headline: render(tpl.h, a, v), body: render(tpl.b, a, v), symbols: [a.sym], report: { analyst: an.name, firm: an.firm, opinion, target } });
    const s = stats[an.id];
    s.recent.unshift({ id: item.id, sym: a.sym, opinion, target, price, tick, hit: null });
    if (s.recent.length > 20) s.recent.length = 20;
    scheduled.push({ at: tick + SCORE_TICKS, kind: "score", analyst: an.id, rid: item.id, sym: a.sym, opinion, price0: price });
  }
  /** 채점: 매수는 0.5% 넘게 올랐으면, 매도는 0.5% 넘게 내렸으면, 중립은 ±4% 안이면 적중 */
  function scoreReport(t: Extract<Task, { kind: "score" }>) {
    const a = state[t.sym], s = stats[t.analyst];
    if (!a || !s) return;
    const chg = a.price / t.price0 - 1;
    const hit = t.opinion === "매수" ? chg > 0.005 : t.opinion === "매도" ? chg < -0.005 : Math.abs(chg) < 0.04;
    s.total++; if (hit) s.hits++;
    const r = s.recent.find(x => x.id === t.rid);
    if (r) r.hit = hit;
  }

  function runTask(t: Task) {
    switch (t.kind) {
      case "list": return listNew();
      case "rescue": return rescue(t.sym);
      case "macro": return macroResult(t);
      case "earnings": return earningsResult(t.sym);
      case "launch": return launchResult(t);
      case "etf": return etfResult(t);
      case "rumor": return rumorResult(t);
      case "memeDump": return memeDump(t);
      case "score": return scoreReport(t);
      case "venture1": {
        const a = state[t.sym];
        if (!a) return;
        react(a.pending, realize(sign() * uni(0, 0.05)));
        return ventureStage(a, 1, t.success, t.eventId, pick(NEWS.venture[1]));
      }
    }
    venturesBusy.delete(t.sym);
    const a = state[t.sym];
    if (!a) return;
    // 결과: 성공 +35%~+120%(상한에 가까우면 줄어듦), 실패 -33%~-63%. 적정가(앵커)도 같은 만큼 이동
    // 성공 폭은 상한에 가까울수록 줄어든다: 시작가 대비 배수 x에서 (1 - log x / log cap)배
    const gain = Math.log(Math.max(1, a.anchor / (a.def.price * a.splitFactor))) / Math.log(cfg.ventureCap);
    const move = t.success ? uni(0.3, 0.8) * Math.max(0, 1 - gain) : -uni(0.4, 1.0);
    a.anchor *= Math.exp(move);
    react(a.pending, move);
    if (t.success) a.successes++;
    a.stage = t.success ? "매출검증" : "상장유지심사";
    ventureStage(a, 2, t.success, t.eventId, pick(NEWS.venture[t.success ? 2 : 3]));
  }
  function noiseNews() {
    const tpl = pick(NEWS.noise);
    publish({ kind: "잡담", headline: tpl.h, body: tpl.b, symbols: [] });
  }
  /** 뉴스 한 건. 비중(%): 시장 11 · 업종 19 · 기업/코인 33(+연쇄) · 신흥주 검증 3 · 리포트 6 · 루머 3 · 공시 3 · 고래 3 · 행사 1.5 · ETF 0.5 · 밈 2 · 지표 예고 1 · 잡담 나머지 (실적은 분기마다 따로) */
  function makeNews() {
    const r = rand();
    // 과거 차트 구간 앞 80%에서는 신흥주 검증을 생략해 시작가 맞추기(rebase) 때 비율이 극단적이지 않게
    const ventureOk = !warm || tick > cfg.warmupBars * cfg.ticksPerBar * 0.8;
    if (r < 0.11) marketNews();
    else if (r < 0.30) sectorNews();
    else if (r < 0.63) companyNews();
    else if (r < 0.66) { if (ventureOk) ventureEvent(); else noiseNews(); }
    else if (r < 0.72) analystReport();
    else if (r < 0.75) rumorNews();
    else if (r < 0.78) disclosureNews();
    else if (r < 0.81) whaleNews();
    else if (r < 0.825) launchAnnounce();
    else if (r < 0.83) etfAnnounce();
    else if (r < 0.85) { if (ventureOk) memeNews(); else noiseNews(); }
    else if (r < 0.86) macroAnnounce();
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
  const prevResetTicks = Math.max(1, cfg.ticksPerDay * Math.max(1, cfg.prevResetDays));

  function step(): StepResult {
    tick++;
    actions = [];
    const before = news.length ? news[0].id : null, versionBefore = assetsVersion;
    for (let j = scheduled.length - 1; j >= 0; j--) if (scheduled[j].at <= tick) runTask(scheduled.splice(j, 1)[0]);
    if (tick >= nextNewsAt) { makeNews(); nextNewsAt = tick + Math.round(uni(...cfg.newsGap)); }

    const m = gauss() * cfg.marketSigma + drain(marketPending);
    const sec: Record<string, number> = {};
    for (const k in sectorPending) sec[k] = gauss() * cfg.sectorSigma + drain(sectorPending[k]);
    const barStart = (tick - 1) % cfg.ticksPerBar === 0, barEnd = tick % cfg.ticksPerBar === 0;
    const growth = Math.exp(drift), devDecay = Math.exp(-Math.LN2 / cfg.epsHalfLife);

    for (const a of live()) {
      if (rand() < cfg.regimeSwitch) a.regime = a.regime === "range" ? "trend" : "range";
      if (a.eps && a.baseEps) {
        a.baseEps *= growth; a.eps *= growth;
        a.eps *= Math.exp((-Math.LN2 / cfg.epsHalfLife) * Math.log(a.eps / a.baseEps));
        a.eps = Math.min(a.baseEps * cfg.epsBand[1], Math.max(a.baseEps * cfg.epsBand[0], a.eps));
      } else {
        a.anchor *= growth;
        a.dev *= devDecay;
      }
      const fair = a.eps && a.fairPER ? a.eps * a.fairPER : a.anchor * Math.exp(a.dev);
      const pull = -cfg.kappa * (a.market === "coin" ? 0.3 : 1) * Math.log(a.price / fair);
      // 박스권: 과매수면 하락 쪽으로, 추세장: 강한 쪽으로 약하게
      const rsiTilt = ((a.rsi - 50) / 50) * cfg.rsiWeight * a.sigma * (a.regime === "range" ? -1 : 0.5);
      const shock = drain(a.pending);
      const noise = gauss() * a.sigma * Math.sqrt(a.variance);
      // drift: 적정가와 같은 속도로 가격도 오른다. 당김(kappa)이 약해도 시즌 우상향을 따라가게 (당김은 이탈만 되돌린다)
      let r = drift + a.betaM * m + a.betaS * (sec[a.sector] || 0) + noise + pull + rsiTilt + srTilt(a) + shock;
      if (a.jump && rand() < a.jump) r += gauss() * a.sigma * 6;
      const open = a.price;
      a.price = Math.max(0.01, a.price * Math.exp(r));
      const z = noise / a.sigma;
      a.variance = Math.min(4, Math.max(0.5, 0.97 * a.variance + 0.03 * (z * z + (shock / a.sigma) ** 2)));

      const vol = Math.round(uni(40, 160) * (1 + Math.abs(r) / a.sigma) * (a.volBoost-- > 0 ? 3 : 1) * (a.market === "venture" ? 2.5 : 1)); // 신흥주는 손바뀜이 많다
      const last = a.bars[a.bars.length - 1];
      if (barStart || !last) {
        a.bars.push({ timestamp: barTime(), open, high: Math.max(open, a.price), low: Math.min(open, a.price), close: a.price, volume: vol });
        if (a.bars.length > cfg.maxBars) a.bars.splice(0, a.bars.length - cfg.maxBars);
      } else {
        last.high = Math.max(last.high, a.price); last.low = Math.min(last.low, a.price); last.close = a.price; last.volume += vol;
      }
      if (barEnd) updateBarStats(a);
    }
    // 등락률 기준가(prev)는 게임 시간 1주일(prevResetDays = 7일)마다 갱신
    if (tick % prevResetTicks === 0) {
      for (const a of live()) a.prev = a.price;
    }
    if (tick % cfg.ticksPerDay === 0 && !warm) {
      reviewListings();
    }
    if (!warm && (tick - seasonStartTick - 1) % QUARTER === 0) earningsSeason(); // 시즌 시작 직후와 분기마다
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
      if (a.market === "stock" && a.fairPER) a.eps = a.baseEps = a.price / a.fairPER; else { a.anchor = a.price; a.dev = 0; }
      a.successes = 0;
      if (!venturesBusy.has(a.sym)) a.stage = null;
    }
    warm = false;
    scheduled = scheduled.filter(t => t.kind !== "score"); // 과거 차트 구간의 리포트는 채점하지 않는다 (가격 비율이 바뀌었다)
    stats = freshStats();
    nextGradAt = tick + Math.round((cfg.gradCooldown / 2) * uni(0.7, 1.3));
  }

  // 스냅샷: 엔진의 모든 상태를 JSON 하나로. 서버 재시작 때 처음부터 재생하지 않고 이어서 돌린다
  function takeSnapshot(): string {
    return JSON.stringify({
      v: SNAPSHOT_VERSION, rng: rng.get(), tick, nextNewsAt, warm, assetsVersion,
      nextGradAt: Number.isFinite(nextGradAt) ? nextGradAt : null, startTime, news, scheduled,
      marketPending, sectorPending, venturesBusy: [...venturesBusy], sparePool, state, drift, analysts: stats,
    });
  }
  function restore(json: string) {
    const d = JSON.parse(json);
    if (d.v !== SNAPSHOT_VERSION) throw new Error(`스냅샷 버전이 다릅니다: ${d.v}`);
    rng.set(d.rng); tick = d.tick; nextNewsAt = d.nextNewsAt; warm = d.warm; assetsVersion = d.assetsVersion;
    nextGradAt = d.nextGradAt ?? Infinity; startTime = d.startTime; news = d.news; scheduled = d.scheduled;
    marketPending = d.marketPending; sectorPending = d.sectorPending; venturesBusy = new Set(d.venturesBusy);
    sparePool = d.sparePool; state = d.state;
    drift = d.drift ?? drift; // drift가 없던 스냅샷은 새로 뽑은 값으로
    stats = d.analysts ?? freshStats();
    for (const a of Object.values(state)) a.dev ??= 0;
    for (const k in sectors) sectorPending[k] ??= [];
    news = news.filter(n => n.kind !== "세력");
    const lastBarTs = Object.values(state)[0]?.bars.at(-1)?.timestamp ?? barTime(Math.max(1, tick));
    for (const def of assets) {
      const a = state[def.sym];
      if (!a) {
        if (def.market === "venture") continue;
        addAsset(def);
        state[def.sym].bars.push({ timestamp: lastBarTs, open: def.price, high: def.price, low: def.price, close: def.price, volume: 0 });
        continue;
      }
      if (def.market === "coin") {
        Object.assign(a, KIND.coin);
        a.eps = null;
        a.baseEps = null;
        a.fairPER = undefined;
      } else if (def.market === "stock") {
        Object.assign(a, KIND.stock);
        if (def.fairPER && !a.fairPER) {
          a.fairPER = def.fairPER;
          const refPrice = a.anchor || a.price;
          a.eps = refPrice / def.fairPER;
          a.baseEps = def.price / def.fairPER;
        }
      }
      if (def.cap && !a.shares) {
        a.shares = def.cap / def.price;
      }
    }
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
  // 호가창 체결의 영구 몫만 기준가·적정가에 남긴다 (사라지는 몫은 호가 봇 재고 헤지가 맡는다)
  function absorbFlow(sym: string, notional: number) {
    const a = state[sym];
    if (!a || !notional) return;
    const sigmaDay = a.sigma * Math.sqrt(cfg.ticksPerDay);
    const impact = Math.min(cfg.impactK * sigmaDay * Math.sqrt(Math.abs(notional) / liquidity(a)), cfg.impactCap[a.market]);
    const permanent = Math.sign(notional) * impact * (1 - cfg.impactTempShare);
    a.price *= Math.exp(permanent);
    if (a.eps && a.baseEps) a.eps *= Math.exp(permanent); else a.anchor *= Math.exp(permanent);
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
    sigma: sym => state[sym]?.sigma ?? null,
    snapshot: takeSnapshot,
    upcoming: () => scheduled.flatMap(t => ("title" in t ? [{ at: t.at, title: t.title, symbols: t.sym ? [t.sym] : [] }] : [])).sort((x, y) => x.at - y.at),
    analysts: () => ANALYSTS.map(x => ({ id: x.id, name: x.name, firm: x.firm, hits: stats[x.id].hits, total: stats[x.id].total, recent: stats[x.id].recent.slice(0, 10) })),
    consensus: sym => {
      const c: Consensus = { buy: 0, hold: 0, sell: 0, target: null };
      let sum = 0, n = 0;
      for (const x of ANALYSTS) {
        const r = stats[x.id].recent.find(y => y.sym === sym && tick - y.tick < QUARTER);
        if (!r) continue;
        if (r.opinion === "매수") c.buy++; else if (r.opinion === "매도") c.sell++; else c.hold++;
        sum += r.target; n++;
      }
      c.target = n ? sum / n : null;
      return c;
    },
    absorbFlow,
  };
}
