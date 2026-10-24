// 도파민 센터 시세 엔진. 서버 GameLoop가 1초마다 step()을 부른다.
//
// 엔진 가격은 화면에 안 나오는 기준가다. 호가창(exchange.ts)의 호가 봇이 이 근처에 호가를 깔고, 화면 가격은 체결가다.
// 틱 수익률 r = 시즌 성장 + 시장 요인 × 베타 + 업종 요인 × 업종 베타 + 개별 노이즈 × 변동성 군집
//             + 뉴스 반응(즉시 → 따라붙음 → 과열 되돌림) + 적정가 회귀 + RSI 기울기(국면에 따라 역추세/추세) + 지지·저항 + 점프
// 뉴스: 시장·업종·기업·코인·신흥주 검증·연쇄·루머·공시·고래 지갑·밈, 예고 뒤 발표(지표·실적·신제품·ETF), 애널리스트 리포트(채점)
// 세력 패턴(개미털기·스퀴즈·설거지·스탑헌팅)은 엔진이 아니라 🏦 세력 계좌가 실제 주문으로 만든다 (apps/server/src/bots.ts).
// 숨은 상태(대기 충격, 국면, 앵커, EPS)는 이 모듈 밖으로 나가지 않는다. 밖으로는 Quote·Bar·NewsItem만.
import { themesOfTech } from "./catalog.ts";
import { ANALYSTS, NEWS, RELATED, type Template } from "./news-templates.ts";
import type { AnalystStat, AnalystView, AssetDef, Bar, Consensus, CorporateAction, GameDate, MarketKind, MarketOptions, NewsItem, Opinion, Quote, SpareDef, StepResult, Upcoming } from "./types.ts";

export const DEFAULT_OPTIONS: MarketOptions = {
  ticksPerBar: 60,        // 1분봉 = 60틱(1초 tick)
  ticksPerDay: 80,        // 게임 하루 (실적·심사·등락률 같은 규칙의 하루)
  calendarDayTicks: 0,    // 화면 달력의 하루 (0이면 ticksPerDay). 서버가 시즌 하나 = 달력 1년이 되게 넣는다. 규칙에는 안 쓴다
  crash: false,           // 시즌마다 한 번 "가상 금융위기" (비공개 규칙, SECRET.md). 서버가 매일 시즌에서 켠다
  calendarOffsetTicks: 0, // 화면 달력이 시즌 시작에 이미 지나 있는 틱 (매일 시즌: 그날 00:00부터 시즌 시작까지). 날짜가 실제 시각에 맞는다
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
  gradCap: 5e9,           // 신흥주 → 주식 승격: 검증 성공 gradSuccesses회 이상 + 시총 50억 달러 (2026-10-23 전: 30억)
  gradSuccesses: 2,
  gradCooldown: 0,        // 승격 사이 평균 간격(±30%). 0이면 시즌 ÷ (maxNewGrowth + 1): 상한이 없으면 0 = 조건이 되는 순간 바로 승격
  gradPER: 15,
  splitPrice: 0.1,        // 신흥주 가격이 $0.10 아래면 주식병합(10:1)
  delistCap: 5e7,         // 시총 5천만 달러 아래면 관리종목 → 유예 기간 뒤에도 미달이면 상장폐지
  watchTicks: 2400,       // 관리종목 유예 기간 (게임 30일 = 40분)
  rescueOdds: [0.3, 0.3], // 유예 중 회생 이벤트 확률: [인수 제안, 유상증자], 나머지는 소식 없음
  maxNewGrowth: Infinity, // 신성장(승격 종목) 최대 개수. 시즌제라 상한 없이 조건(검증 성공 + 시총)만 되면 승격한다 (2026-10-23 전: 10)
  ventureCap: 300,        // 신흥주 소프트 상한: 시작가 대비 이 배수에 가까울수록 검증 성공 상승폭이 줄어든다 (100배 전설 보정으로 100 → 300)
  ventureSuccess: 0.7,    // 신흥주 검증 성공 확률 (2026-10-23: 사람 거래의 75%가 신흥주로 쏠려 0.85 → 0.7)
  epsHalfLife: 172_800,   // EPS가 기준값으로 돌아가는 반감기(틱, 2일)
  epsBand: [0.4, 3],      // EPS(= 적정가)는 기준의 0.4~3배 안에서만 움직인다
  // 호가창 두께와 순매수의 영구 몫: 충격 = impactK × σ_일 × √(명목 금액 / 가상 유동성). 호가 봇이 같은 크기로 호가를 깐다
  impactK: 2,
  impactCap: { stock: 0.03, coin: 0.05, venture: 0.15 }, // tick당 충격 상한
  impactTempShare: 0.7,   // 충격 중 사라지는 몫(호가 봇 재고 헤지가 맡음). 나머지 30%는 기준가·적정가에 남는다
};

const KIND: Record<MarketKind, { sigma: number; betaM: number; betaS: number; jump: number }> = {
  stock: { sigma: 0.00085, betaM: 1.0, betaS: 1.45, jump: 0 },
  coin: { sigma: 0.00095, betaM: 1.0, betaS: 2.15, jump: 0 },       // 2026-10-24 시장 베타 0.75 → 1.0 (위험자산 심리를 따라간다)
  venture: { sigma: 0.0032, betaM: 1.3, betaS: 1.2, jump: 0.002 },  // 2026-10-24 시장 0.5 → 1.3, 업종 0.9 → 1.2 (소형 테마주는 과하게 반응)
};
/** 테마 업종 반응: 주 업종 반응(betaS)에 곱한다. 주식은 여러 테마에 걸쳐 있어 약하게, 신흥주는 테마가 곧 업종이라 그대로 */
const THEME_W: Record<MarketKind, number> = { stock: 0.6, coin: 0, venture: 1 };

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
  /** 가상 금융위기 충격: 가격에만 더하고 변동성(variance)에는 넣지 않는다 (안 그러면 위기 뒤 한동안 마구 흔들린다) */
  crashPending?: Impulse[];
  /** 가상 금융위기 동안의 바닥: 위기 직전 가격 × (1 - 낙폭). 다른 뉴스·흔들림이 겹쳐도 이 아래로는 안 간다 (위기 충격이 다 빠지면 지운다) */
  crashFloor?: number | null;
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
  themes: string[];
  /** 신흥주 실적 (2026-10-24): 연 매출($), 발표된 이익률(적자면 음수), 다음 발표 때 다가갈 숨은 이익률(검증 결과가 움직인다). 주식·코인은 null */
  revenue: number | null;
  margin: number | null;
  outlook: number | null;
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
  /** 가상 금융위기 투매 구간인지 (서버의 세력·고래가 매물을 던진다). 화면·API로 내보내지 않는다 */
  crashing(): boolean;
  /** 결과가 정해진 채 예약된 종목 사건 (신제품 행사·코인 ETF·루머 확인). 세력의 "선취매"용이라 화면·API로 내보내지 않는다 */
  insider(within: number): { sym: string; at: number; dir: 1 | -1 }[];
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
  | { at: number; kind: "crash" }
  | { at: number; kind: "crashNews"; step: 1 | 2 }
  | { at: number; kind: "score"; analyst: string; rid: string; sym: string; opinion: Opinion; price0: number };
const SNAPSHOT_VERSION = 1;

// 가상 금융위기 원인 (실존 기관·인물 없음). 시즌마다 하나를 뽑는다
const CRASH_REASONS = [
  { h: "가상 대형 투자은행 파산설 확산", b: "자산 규모 상위권의 가상 투자은행이 지급 불능 상태라는 소식이 퍼지며 금융권 전반으로 공포가 번지고 있다." },
  { h: "가상 중앙은행 기습 금리 인상", b: "예고 없는 대폭 금리 인상에 위험자산 전반에서 대규모 매도가 쏟아지고 있다." },
  { h: "가상 국채 시장 발작, 금리 폭등", b: "국채 금리가 하루 만에 급등하며 레버리지 자금이 한꺼번에 빠져나가고 있다." },
  { h: "대형 가상 헤지펀드 마진콜 연쇄 청산", b: "초대형 가상 헤지펀드의 마진콜이 연쇄 강제 청산으로 번지며 전 시장에 매물이 쏟아지고 있다." },
  { h: "가상 거대 부동산 개발사 디폴트", b: "대형 가상 부동산 개발사의 채무 불이행 소식에 신용 경색 우려가 확산하고 있다." },
  { h: "가상 거래소 해킹, 코인 대량 유출설", b: "대형 가상 코인 거래소에서 대규모 유출 정황이 포착됐다는 소식에 코인과 위험자산이 동반 급락하고 있다." },
  { h: "가상 무역 전쟁 전면 확대 선언", b: "주요국 간 관세 전쟁이 전면전으로 번지며 경기 침체 공포가 시장을 덮쳤다." },
  { h: "가상 반도체 공급망 붕괴", b: "핵심 가상 공급망이 멈췄다는 소식에 기술주를 시작으로 전 업종이 무너지고 있다." },
  { h: "가상 스테이블코인 페그 붕괴", b: "대표 가상 스테이블코인의 1달러 연동이 깨지며 코인 시장에서 시작된 패닉이 증시로 번지고 있다." },
  { h: "가상 신용평가사, 국가 신용등급 강등", b: "가상 신용평가사의 기습적인 국가 신용등급 강등에 외국인 자금이 한꺼번에 이탈하고 있다." },
];

// 지어 낸 신흥주 이름 조각: 앞(2자 기호) + 뒤(1자 기호) + 무작위 1자 = 4자 티커
const VENTURE_HEADS = [
  { name: "네오", sym: "NE" }, { name: "퀀텀", sym: "QT" }, { name: "아스트로", sym: "AS" }, { name: "하이퍼", sym: "HP" }, { name: "에코", sym: "EC" },
  { name: "나노", sym: "NN" }, { name: "제네", sym: "GN" }, { name: "옵티", sym: "OP" }, { name: "테라", sym: "TR" }, { name: "크로노", sym: "CR" },
  { name: "루나", sym: "LN" }, { name: "벡터", sym: "VC" }, { name: "플라즈", sym: "PZ" }, { name: "소닉", sym: "SN" }, { name: "오로라", sym: "AR" },
];
const VENTURE_TAILS = [
  { name: "젠", sym: "G" }, { name: "랩스", sym: "L" }, { name: "텍", sym: "T" }, { name: "셀", sym: "C" }, { name: "웍스", sym: "W" },
  { name: "메드", sym: "M" }, { name: "에너지", sym: "E" }, { name: "모빌리티", sym: "B" }, { name: "시스", sym: "S" }, { name: "팜", sym: "F" },
];
const VENTURE_TECHS = [
  "고체 전해질 배터리", "단백질 접힘 신약", "초소형 위성 통신", "양자 암호 칩", "합성 연료 촉매", "뇌파 인터페이스", "자율 수중 드론",
  "탄소 나노튜브 섬유", "유전자 편집 작물", "초전도 송전선", "마이크로 원자로", "생분해 플라스틱", "AI 신약 설계", "레이저 핵융합 연료",
];

export function createMarket({ assets, sectors, spares = [], seed = 20261021, now = Date.now(), options = {}, snapshot }: CreateMarketInput): Market {
  const merged: MarketOptions = { ...DEFAULT_OPTIONS, ...options };
  const cfg: MarketOptions = { ...merged, gradCooldown: merged.gradCooldown || Math.round(merged.seasonTicks / (merged.maxNewGrowth + 1)) };
  const rng = mulberry32(seed), rand = rng.next;
  const uni = (a: number, b: number) => a + (b - a) * rand();
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
  const sign = () => (rand() < 0.5 ? -1 : 1);

  let startTime = Math.floor(now / cfg.barMs) * cfg.barMs - (cfg.warmupBars - 1) * cfg.barMs;
  let tick = 0, nextNewsAt = 3, warm = true, assetsVersion = 0, nextGradAt = Infinity, crashUntil = 0;
  let news: NewsItem[] = [];
  let actions: CorporateAction[] = []; // 이번 tick의 주식병합·폐지·승격·상장 (서버가 보유 정산에 쓴다)
  let scheduled: Task[] = [];
  let marketPending: Impulse[] = [];
  let sectorPending: Record<string, Impulse[]> = {};
  let venturesBusy = new Set<string>();
  let sparePool: SpareDef[] = spares.map(s => ({ ...s }));
  let state: Record<string, AssetState> = {};
  const live = () => Object.values(state);

  /** 신흥주 첫 실적: 매출은 시총의 3~15%(PSR 7~33배), 이익률은 -40%~+5% (대부분 적자) */
  function ventureBooks(a: AssetState) {
    a.revenue = (a.shares ? a.shares * a.price : a.price * 1e8) * uni(0.03, 0.15); // capOf는 아래에서 정의된다
    a.margin = a.outlook = uni(-0.4, 0.05);
  }
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
      themes: def.themes ?? (def.market === "venture" ? themesOfTech(def.tech) : []),
      revenue: null, margin: null, outlook: null,
    };
    if (def.market === "venture") ventureBooks(state[def.sym]);
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
  // 뉴스 반응 모양 10가지 (2026-10-24: 모양이 하나뿐이라 몇 판 하면 읽혀서 늘렸다). 첫 1~2분만 보고는 어느 쪽인지 알기 어렵게.
  // 확률·크기는 예전과 같다: followChance(60%)면 끝내 total만큼 가는 6가지 중 하나, 아니면 재료 소진으로 일부만 남는 4가지 중 하나
  function react(list: Impulse[], total: number) {
    const T = total, n = (a: number, b: number) => Math.round(uni(a, b));
    if (rand() < cfg.followChance) {
      switch (Math.floor(rand() * 6)) {
        case 0: { const now = uni(0.85, 1); impulse(list, T * now, n(3, 6)); impulse(list, T * (1 - now), n(10, 20), 6); return; } // 즉시 반응 후 유지
        case 1: { // 계단식: 2~3번 나눠서, 사이사이 쉰다
          const k = rand() < 0.5 ? 2 : 3, w = Array.from({ length: k }, () => uni(0.5, 1)), sw = w.reduce((x, y) => x + y, 0);
          let at = 0;
          for (const x of w) { impulse(list, (T * x) / sw, n(4, 8), at); at += n(40, 90); }
          return;
        }
        case 2: { const d = n(60, 180); impulse(list, T * 0.1, n(3, 6)); impulse(list, T * 0.9, n(6, 15), d); return; } // 늦은 반응
        case 3: { const fake = uni(0.15, 0.35); impulse(list, -T * fake, n(4, 8)); impulse(list, T * (1 + fake), n(15, 30), n(20, 50)); return; } // 페이크 아웃
        case 4: { // 과열 후 안정
          const now = uni(0.45, 0.8), over = uni(0.2, 0.5);
          impulse(list, T * now, n(3, 8)); impulse(list, T * (1 - now + over), n(20, 40), 3); impulse(list, -T * over, n(30, 60), n(45, 75));
          return;
        }
        default: impulse(list, T, n(300, 700)); return; // 천천히
      }
    }
    switch (Math.floor(rand() * 4)) {
      case 0: { const now = uni(0.45, 0.8); impulse(list, T * now, n(3, 8)); impulse(list, -T * now * uni(0.15, 0.5), n(15, 35), 3); return; } // 절반 반납
      case 1: { const now = uni(0.6, 0.9), left = uni(0.2, 0.4); impulse(list, T * now, n(3, 8)); impulse(list, -T * (now - left), n(40, 90), n(10, 30)); return; } // 뉴스에 팔아라
      case 2: { // 위아래 흔들기: 올랐다가 출발점 아래로, 다시 조금 위
        const up = uni(0.5, 0.8), down = up + uni(0.3, 0.6), end = uni(0.3, 0.6);
        impulse(list, T * up, n(3, 6)); impulse(list, -T * down, n(8, 16), n(10, 25)); impulse(list, T * (end - up + down), n(10, 20), n(40, 70));
        return;
      }
      default: impulse(list, T * uni(0.2, 0.45), n(60, 200), n(5, 30)); return; // 무반응에 가깝게
    }
  }
  // 의도한 충격 → 실제 반영량 (0.3~1.5배, 가끔 반대)
  const realize = (intended: number, flip = cfg.flipChance) => intended * uni(0.3, 1.5) * (rand() < flip ? -1 : 1);

  // ---------- 시간 ----------
  // 시즌 달력은 과거 차트(warmup)가 끝난 시점부터 1년차 1월 1일. 그 전은 year 0 = "시즌 전"
  const seasonStartTick = cfg.warmupBars * cfg.ticksPerBar;
  const gameDate = (t = tick): GameDate => {
    if (t < seasonStartTick) return { year: 0, month: 0, day: 0 };
    const raw = Math.floor((t - seasonStartTick + cfg.calendarOffsetTicks) / (cfg.calendarDayTicks || cfg.ticksPerDay));
    const d = cfg.calendarDayTicks ? Math.min(359, raw) : raw; // 매일 시즌의 달력은 1년(12월 30일)에서 멈춘다
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
  /**
   * 업종 뉴스: 주 업종이 그 업종이거나 테마로 가진 종목이 함께 움직인다.
   * theme이면 테마 업종(AI·양자·모빌리티)과 신흥주 업종 중 하나 (2026-10-24, 기존 업종 뉴스 빈도는 그대로 두고 따로 3%)
   */
  function sectorNews(theme = false) {
    const inSector = (a: AssetState, key: string) => a.sector === key || a.themes.includes(key);
    const members = (key: string) => live().filter(a => inSector(a, key)).map(a => a.sym);
    const isMain = (k: string) => k !== "venture" && live().some(a => a.sector === k);
    const keys = Object.keys(sectors).filter(k => members(k).length && (theme ? !isMain(k) : isMain(k)));
    if (!keys.length) return noiseNews();
    const key = pick(keys), name = sectors[key];
    const good = rand() < 0.80, only = NEWS.sectorOnly[key];
    const tpl = pick([...(good ? NEWS.sector.good : NEWS.sector.bad), ...(only ? (good ? only.good : only.bad) : [])]);
    const move = good ? realize(uni(0.01, 0.026), PRICED_IN) : realize(-uni(0.033, 0.07), 0.08);
    react(sectorPending[key], move);
    for (const a of live()) {
      if (a.sector === key) shiftFair(a, move * a.betaS * FAIR_SHARE);
      else if (a.themes.includes(key)) shiftFair(a, move * a.betaS * THEME_W[a.market] * FAIR_SHARE);
    }
    const v = { sector: name, pct: pctOf(move, 300) };
    publish({ kind: "업종", sector: key, headline: `${name} 업종 · ${render(tpl.h, null, v)}`, body: render(tpl.b, null, v), symbols: members(key) });
  }
  function companyNews() {
    const a = pick(live().filter(x => x.market !== "venture"));
    const good = rand() < 0.82, src = a.market === "coin" ? NEWS.coin : NEWS.company;
    const tpl: Template = pick(good ? src.good : src.bad);
    // 개별 회사·코인 뉴스는 그 종목에 반응한다 (관련주는 연쇄 뉴스로). 실적 관련 뉴스는 적정가에 더 많이 남는다
    // 2026-10-23 약 1.4배로 키움 (신흥주 말고 주식·코인에도 큰 기회가 있게)
    const rawMag = a.market === "coin"
      ? (good ? uni(0.05, 0.13) : -uni(0.16, 0.38))
      : (good ? uni(0.03, 0.085) : -uni(0.11, 0.25));
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
  /** 실적 시즌: 분기가 시작되면 주식·신흥주마다 발표 시각을 정해 일정에 올린다 (신흥주는 2026-10-24부터) */
  function earningsSeason() {
    const list = live().filter(x => x.market !== "coin");
    for (const a of list) scheduled.push({ at: tick + Math.round(uni(5 * MIN, QUARTER - 5 * MIN)), kind: "earnings", sym: a.sym, title: `${a.name}(${a.sym}) 실적 발표` });
    publish({ kind: "실적", headline: render(NEWS.earnings.season.h, null, { n: list.length }), body: NEWS.earnings.season.b, symbols: [] });
  }
  function earningsResult(sym: string) {
    const a = state[sym];
    if (a?.market === "venture") return ventureEarnings(a);
    if (!a || a.market !== "stock") return;
    // 깜짝 실적 60% × 3~20% ≈ 쇼크 40% × 5~30%. 주가는 서프라이즈의 60%만큼(2026-10-23 전: 40%), 적정가에 2배로 남는다
    const good = rand() < 0.6, surprise = good ? uni(3, 20) : uni(5, 30), move = (good ? 1 : -1) * surprise / 100 * 0.6;
    hitAsset(a, move, 2 * FAIR_SHARE, 16);
    const tpl = pick(good ? NEWS.earnings.good : NEWS.earnings.bad), v = { pct: Math.round(surprise) };
    publish({ kind: "실적", headline: render(tpl.h, a, v), body: render(tpl.b, a, v), symbols: [a.sym] });
    chain(a, move);
  }
  /**
   * 신흥주 실적: 이익률이 숨은 전망(검증 결과가 움직인다) 쪽으로 60% 다가가고 흔들린다. 매출은 분기 -5%~+25%.
   * 흑자 전환 +15~40% · 적자 축소/매출 급증 +5~20% · 부합 작게 · 적자 확대 -10~30% · 적자 전환 -20~40%. 적정가(앵커)도 같은 만큼
   */
  function ventureEarnings(a: AssetState) {
    if (a.margin == null || a.outlook == null || a.revenue == null) ventureBooks(a);
    const before = a.margin!, growth = uni(-0.05, 0.25);
    a.revenue! *= 1 + growth;
    a.margin = Math.min(0.35, Math.max(-0.8, before + 0.6 * (a.outlook! - before) + gauss() * 0.05));
    const after = a.margin, kind = before < 0 && after >= 0 ? "turnaround" : before >= 0 && after < 0 ? "toLoss"
      : after > before + 0.02 || growth > 0.15 ? "better" : after < before - 0.02 ? "worse" : "inline";
    const move = kind === "turnaround" ? uni(0.15, 0.4) : kind === "toLoss" ? -uni(0.2, 0.4) : kind === "better" ? uni(0.05, 0.2)
      : kind === "worse" ? -uni(0.1, 0.3) : gauss() * 0.02;
    a.anchor *= Math.exp(move);
    react(a.pending, move);
    a.volBoost = 16;
    const tpl = pick(NEWS.ventureEarnings[kind]);
    const v = { margin: `${after < 0 ? "-" : ""}${Math.abs(Math.round(after * 100))}%`, growth: `${Math.round(growth * 100)}%` };
    publish({ kind: "실적", headline: render(tpl.h, a, v), body: render(tpl.b, a, v), symbols: [a.sym] });
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
    const move = t.outcome === "good" ? uni(0.05, 0.11) : t.outcome === "sellNews" ? -uni(0.03, 0.07) : -uni(0.07, 0.15); // 2026-10-23 약 1.5배로 키움
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
    const move = t.approve ? uni(0.12, 0.27) : -uni(0.08, 0.18); // 2026-10-23 약 1.5배로 키움
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
    const good = rand() < 0.5, move = (good ? 1 : -1) * uni(0.03, 0.09), tpl = pick(good ? NEWS.whale.good : NEWS.whale.bad);
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
      + a.betaS * THEME_W[a.market] * a.themes.reduce((t, k) => t + left(sectorPending[k] ?? []), 0)
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
      case "crash": return crash();
      case "crashNews": return crashNews(t.step);
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
    // 검증 결과는 다음 실적의 이익률 전망에 남는다: 성공이면 개선, 실패면 악화
    if (a.outlook != null) a.outlook = Math.min(0.35, Math.max(-0.8, a.outlook + (t.success ? uni(0.08, 0.2) : -uni(0.05, 0.15))));
    if (t.success) a.successes++;
    a.stage = t.success ? "매출검증" : "상장유지심사";
    ventureStage(a, 2, t.success, t.eventId, pick(NEWS.venture[t.success ? 2 : 3]));
  }
  function noiseNews() {
    const tpl = pick(NEWS.noise);
    publish({ kind: "잡담", headline: tpl.h, body: tpl.b, symbols: [] });
  }
  /** 뉴스 한 건. 비중(%): 시장 11 · 업종 19 · 테마·신흥주 업종 3 · 기업/코인 33(+연쇄) · 신흥주 검증 3 · 리포트 6 · 루머 3 · 공시 3 · 고래 3 · 행사 1.5 · ETF 0.5 · 밈 2 · 지표 예고 1 · 잡담 나머지 (실적은 분기마다 따로) */
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
    else if (r < 0.89) sectorNews(true);
    else noiseNews();
  }

  // ---------- 신흥주 승격 · 상장폐지 · 신규 상장 ----------
  function graduate(a: AssetState) {
    const fill = fillOf(a);
    Object.assign(a, KIND.stock, { market: "stock", sector: "newgrowth", sigma: 0.0016, fairPER: cfg.gradPER, eps: a.price / cfg.gradPER, baseEps: a.price / cfg.gradPER, stage: null,
      revenue: null, margin: null, outlook: null }); // 주식이 되면 PER은 EPS로
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
    const [d] = i >= 0 ? sparePool.splice(i, 1) : [inventVenture()], price = Math.round(uni(2, 10) * 100) / 100;
    addAsset({ ...d, market: "venture", sector: "venture", price, cap: price * Math.round(uni(5e7, 2e8)), parValue: d.parValue ?? 0.1 });
    const a = state[d.sym], fill = fillOf(a);
    a.bars.push({ timestamp: barTime(), open: price, high: price, low: price, close: price, volume: 0 });
    actions.push({ type: "list", sym: a.sym });
    publish({ kind: "신흥주", headline: `${a.name}(${a.sym}) · ${fill(NEWS.listing.ipo.h)}`, body: fill(NEWS.listing.ipo.b), symbols: [a.sym] });
  }
  // 예비 가상 기업이 바닥나면(승격에 상한이 없다) 이름을 지어 낸다. seed 난수라 같은 seed면 같은 이름. 이름 끝에 "가상" 표기는 화면이 붙인다
  function inventVenture(): SpareDef {
    const taken = new Set([...Object.keys(state), ...sparePool.map(d => d.sym)]);
    for (;;) {
      const [head, tail, tech] = [pick(VENTURE_HEADS), pick(VENTURE_TAILS), pick(VENTURE_TECHS)];
      const sym = head.sym + tail.sym + String.fromCharCode(65 + Math.floor(rand() * 26));
      if (!taken.has(sym)) return { sym, name: head.name + tail.name, tech };
    }
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
      // 가상 금융위기 뒤 1시간은 과매도 되돌림(RSI)을 끈다: 안 그러면 바닥에서 위기 전 가격까지 튀어 오른다
      const rsiTilt = crashUntil && tick < crashUntil + 3600 ? 0 : ((a.rsi - 50) / 50) * cfg.rsiWeight * a.sigma * (a.regime === "range" ? -1 : 0.5);
      const shock = drain(a.pending);
      const noise = gauss() * a.sigma * Math.sqrt(a.variance);
      // drift: 적정가와 같은 속도로 가격도 오른다. 당김(kappa)이 약해도 시즌 우상향을 따라가게 (당김은 이탈만 되돌린다)
      const crashShock = a.crashPending?.length ? drain(a.crashPending) : 0;
      let themeMove = 0;
      for (const k of a.themes) themeMove += sec[k] || 0;
      let r = drift + a.betaM * m + a.betaS * ((sec[a.sector] || 0) + THEME_W[a.market] * themeMove) + noise + pull + rsiTilt + srTilt(a) + shock + crashShock;
      if (a.jump && rand() < a.jump) r += gauss() * a.sigma * 6;
      const open = a.price;
      a.price = Math.max(0.01, a.price * Math.exp(r));
      if (a.crashFloor) {
        if (a.price < a.crashFloor) a.price = a.crashFloor * Math.exp(Math.abs(gauss()) * a.sigma); // 바닥에서 튕긴다 (긴 아래꼬리)
        if (!a.crashPending?.length) a.crashFloor = null;
      }
      const z = noise / a.sigma;
      a.variance = Math.min(4, Math.max(0.5, 0.97 * a.variance + 0.03 * (z * z + (shock / a.sigma) ** 2)));

      const vol = Math.round(uni(40, 160) * (1 + Math.abs(r) / a.sigma) * (a.volBoost-- > 0 ? 3 : 1) * (a.market === "venture" ? 2.5 : 1)); // 신흥주는 손바뀜이 많다
      const last = a.bars[a.bars.length - 1];
      if (!last || (barStart && last.timestamp !== barTime())) { // 이번 봉 시작에 막 상장한 종목은 이미 이 시각 봉이 있다
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
  // ----- 가상 금융위기 (SECRET.md): 예고 없이 한 번에 터지고, 세력 차트처럼 계단식으로 최대 -30%, 바닥에서 -24%까지만 회복 -----
  function crash() {
    const reason = CRASH_REASONS[Math.floor(rand() * CRASH_REASONS.length)];
    for (const a of live()) {
      // 바닥 -depth, 그 뒤 -0.8×depth에서 멈춘다
      // 낙폭(위기 직전 가격 대비): 코인·신흥주 27~30%, 주식은 베타에 따라 15~30% (2026-10-24 전: 최대 50%)
      const depth = a.market === "stock" ? Math.min(0.3, Math.max(0.15, 0.13 + 0.12 * a.betaM)) * uni(0.92, 1.0) : uni(0.27, 0.3);
      const L = Math.log(1 - depth), settle = Math.log(1 - 0.8 * depth);
      // 회복은 위기 직전 가격의 settle까지만: 적정가를 거기로 옮긴다 (거품이 있었어도 기준은 직전 가격)
      const target = a.price * Math.exp(settle);
      if (a.eps != null && a.baseEps != null && a.fairPER) a.eps = Math.min(a.baseEps * cfg.epsBand[1], Math.max(a.baseEps * cfg.epsBand[0], target / a.fairPER));
      else a.dev = Math.min(devBand[1], Math.max(devBand[0], Math.log(target / a.anchor)));
      a.crashFloor = a.price * (1 - depth);
      const q = (a.crashPending ??= []);
      impulse(q, 0.45 * L, 180);                    // 1차 급락 (3분)
      impulse(q, -0.12 * L, 150, 360);              // 데드캣 반등
      impulse(q, 0.5 * L, 240, 600);                // 2차 급락 (반등에 산 롱 청산)
      impulse(q, 0.17 * L, 90, 900);                // 마지막 투매 (긴 아래꼬리)
      impulse(q, (settle - L) * 0.85, 1200, 1050);  // 바닥에서 일부 회복 (나머지는 적정가 당김)
      a.volBoost = Math.max(a.volBoost, 1100);
    }
    crashUntil = tick + 1000;
    scheduled.push({ at: tick + 620, kind: "crashNews", step: 1 }, { at: tick + 1060, kind: "crashNews", step: 2 });
    publish({ kind: "시장", headline: `[속보] 가상 금융위기 · ${reason.h}… 전 시장 투매`, body: reason.b, symbols: [] });
  }
  function crashNews(step: 1 | 2) {
    if (step === 1) publish({ kind: "시장", headline: "[속보] 공포 확산 · 마진콜 연쇄, 반등 뒤 투매 재개", body: "반등을 노린 매수세가 다시 꺾이며 레버리지 포지션의 강제 청산이 이어지고 있다.", symbols: [] });
    else publish({ kind: "시장", headline: "가상 당국 긴급 시장 안정 조치 · 낙폭 일부 만회", body: "긴급 유동성 공급 발표 뒤 투매가 진정됐다. 다만 시장은 위기 이전 수준을 회복하지 못하고 있다.", symbols: [] });
  }

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
    // 가상 금융위기: 시즌의 30~80% 사이 어딘가 한 번. 따로 뽑는 난수라 다른 시세 경로는 그대로
    if (cfg.crash) scheduled.push({ at: tick + Math.round(cfg.seasonTicks * (0.3 + 0.5 * mulberry32(seed ^ 0x5eed).next())), kind: "crash" });
  }

  // 스냅샷: 엔진의 모든 상태를 JSON 하나로. 서버 재시작 때 처음부터 재생하지 않고 이어서 돌린다
  function takeSnapshot(): string {
    return JSON.stringify({
      v: SNAPSHOT_VERSION, rng: rng.get(), tick, nextNewsAt, warm, assetsVersion,
      nextGradAt: Number.isFinite(nextGradAt) ? nextGradAt : null, startTime, news, scheduled,
      marketPending, sectorPending, venturesBusy: [...venturesBusy], sparePool, state, drift, analysts: stats, crashUntil,
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
    crashUntil = d.crashUntil ?? 0;
    // 위기 규칙이 생기기 전 스냅샷(이미 진행 중인 시즌): 아직 안 터졌고 시즌 80% 전이면 지금부터 그 사이 어딘가로 잡는다
    if (cfg.crash && !d.warm && crashUntil === 0 && !scheduled.some(t => t.kind === "crash")) {
      const start = cfg.warmupBars * cfg.ticksPerBar, lo = Math.max(tick + 600, start + Math.round(cfg.seasonTicks * 0.3)), hi = start + Math.round(cfg.seasonTicks * 0.8);
      if (lo < hi) scheduled.push({ at: lo + Math.round((hi - lo) * mulberry32(seed ^ 0x5eed).next()), kind: "crash" });
    }
    for (const a of Object.values(state)) {
      a.dev ??= 0;
      // 테마·신흥주 실적이 생기기 전 스냅샷 (2026-10-24): 테마는 카탈로그·기술 분야로, 신흥주 실적은 종목 코드로 정한 값으로 채운다
      // (매출 시총의 3~15%, 이익률 -40%~+5%. 난수를 쓰지 않아 재생 경로가 그대로)
      a.themes ??= assets.find(d => d.sym === a.sym)?.themes ?? (a.market === "venture" ? themesOfTech(a.tech) : []);
      if (a.revenue === undefined) {
        a.revenue = a.margin = a.outlook = null;
        if (a.market === "venture") {
          const h = [...a.sym].reduce((t, ch) => (t * 31 + ch.charCodeAt(0)) % 1000, 7) / 1000;
          a.revenue = (capOf(a) ?? 0) * (0.03 + 0.12 * h);
          a.margin = a.outlook = -0.4 + 0.45 * ((h * 7) % 1);
        }
      }
      if (a.market === "venture") Object.assign(a, { betaM: KIND.venture.betaM, betaS: KIND.venture.betaS });
    }
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
        a.themes = def.themes ?? [];
        a.eps = null;
        a.baseEps = null;
        a.fairPER = undefined;
      } else if (def.market === "stock") {
        Object.assign(a, KIND.stock);
        a.themes = def.themes ?? [];
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

  /** 신흥주 PER = 가격 / (매출 × 이익률 / 주식 수). 적자면 음수, 이익률 0이면 없음 */
  const venturePer = (a: AssetState) => (a.revenue && a.margin && a.shares ? a.price / ((a.revenue * a.margin) / a.shares) : null);
  const toQuote = (a: AssetState): Quote => ({
    sym: a.sym, name: a.name, market: a.market, sector: a.sector, price: a.price, prev: a.prev,
    per: a.eps ? a.price / a.eps : venturePer(a), cap: capOf(a), stage: a.stage, parValue: a.par, splitFactor: a.splitFactor,
    revenue: a.revenue, themes: a.themes,
  });

  return {
    options: cfg,
    get tick() { return tick; },
    get assetsVersion() { return assetsVersion; },
    get news() { return news; },
    step,
    gameDate: () => gameDate(),
    crashing: () => tick < crashUntil,
    insider: (within: number) => scheduled.flatMap(t => {
      if (t.at - tick > within || t.at <= tick) return [];
      if (t.kind === "launch") return [{ sym: t.sym, at: t.at, dir: t.outcome === "good" ? 1 as const : -1 as const }];
      if (t.kind === "etf") return [{ sym: t.sym, at: t.at, dir: t.approve ? 1 as const : -1 as const }];
      if (t.kind === "rumor") return [{ sym: t.sym, at: t.at, dir: t.confirm ? 1 as const : -1 as const }];
      return [];
    }),
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
