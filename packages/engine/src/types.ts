export type MarketKind = "stock" | "coin" | "venture";

/** 종목 정의 (카탈로그). price는 시즌 시작가. */
export interface AssetDef {
  sym: string;
  name: string;
  market: MarketKind;
  sector: string;
  price: number;
  cap?: number;
  fairPER?: number;
  product?: string;
  tech?: string;
  /** 액면가. 코인은 없음. 주식병합 때 ratio배가 된다 */
  parValue?: number;
  /** 코인의 가상 유동성 (게임 하루 거래대금). 주식·신흥주는 시총에서 계산 */
  liquidity?: number;
  /** 주 업종 말고 같이 움직이는 테마 업종 (SECTORS의 키). 신흥주는 없으면 기술 분야(tech)로 정한다 */
  themes?: string[];
}

/** 신흥주 예비 목록 항목. 상장할 때 가격·시총은 엔진이 정한다. */
export interface SpareDef {
  sym: string;
  name: string;
  tech: string;
  parValue?: number;
}

export interface Bar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface GameDate {
  year: number;
  month: number;
  day: number;
}

export interface NewsEvent {
  id: string;
  index: number;
  total: number;
  label: string;
}

/** 클라이언트에 그대로 내보내도 되는 뉴스. 숨은 충격값은 들어 있지 않다. */
export interface NewsItem {
  id: string;
  tick: number;
  at: number;
  date: GameDate;
  kind: string;
  headline: string;
  body: string;
  symbols: string[];
  priceAt: Record<string, number>;
  sector?: string;
  event?: NewsEvent;
  delisted?: boolean;
  /** 애널리스트 리포트 */
  report?: { analyst: string; firm: string; opinion: Opinion; target: number };
}

export type Opinion = "매수" | "중립" | "매도";
/** 리포트 하나. hit: 13분 뒤 채점 결과 (아직이면 null) */
export interface AnalystReport { id: string; sym: string; opinion: Opinion; target: number; price: number; tick: number; hit: boolean | null }
export interface AnalystStat { hits: number; total: number; recent: AnalystReport[] }
/** 화면에 보내는 애널리스트 (성향은 숨김) */
export interface AnalystView extends AnalystStat { id: string; name: string; firm: string }
export interface Consensus { buy: number; hold: number; sell: number; target: number | null }
/** 예고된 일정. at = 발표 tick */
export interface Upcoming { at: number; title: string; symbols: string[] }

/** 클라이언트에 보여줄 시세. 엔진 내부 상태(앵커, 국면, 대기 충격)는 없다. */
export interface Quote {
  sym: string;
  name: string;
  market: MarketKind;
  sector: string;
  price: number;
  prev: number;
  per: number | null;
  cap: number | null;
  stage: string | null;
  parValue: number | null;
  /** 시즌 시작 뒤 누적 주식병합 배수. 차트 그림을 새 가격으로 옮길 때 쓴다 */
  splitFactor: number;
  /** 신흥주 연 매출 ($, 실적 발표 때 바뀐다). 주식·코인은 null */
  revenue?: number | null;
  /** 같이 움직이는 테마 업종 (SECTORS의 키) */
  themes?: string[];
}

/** 보유 정산이 필요한 상장 변화. split: 수량 ÷ ratio·평단 × ratio, delist: price로 청산 */
export type CorporateAction =
  | { type: "split"; sym: string; ratio: number }
  | { type: "delist"; sym: string; price: number }
  | { type: "graduate"; sym: string }
  | { type: "list"; sym: string };

export interface StepResult {
  news: NewsItem[];
  barClosed: boolean;
  assetsChanged: boolean;
  actions: CorporateAction[];
}

export interface MarketOptions {
  ticksPerBar: number;
  ticksPerDay: number;
  /** 화면 달력(gameDate)의 하루 길이(틱). 0이면 ticksPerDay. 가격·뉴스 규칙에는 안 쓴다 */
  calendarDayTicks: number;
  /** 시즌마다 한 번 "가상 금융위기" (비공개 규칙) */
  crash: boolean;
  /** 화면 달력이 시즌 시작에 이미 지나 있는 틱 (날짜를 실제 시각에 맞춘다) */
  calendarOffsetTicks: number;
  prevResetDays: number;
  /** 시즌 동안 적정가가 오르는 배수 [최소, 최대]. 시즌마다 이 안에서 하나를 뽑는다 */
  seasonGrowth: [number, number];
  /** 시즌 길이(틱). 서버가 시즌 설정에서 넣는다 */
  seasonTicks: number;
  barMs: number;
  warmupBars: number;
  maxBars: number;
  newsGap: [number, number];
  marketSigma: number;
  sectorSigma: number;
  kappa: number;
  rsiPeriod: number;
  rsiWeight: number;
  regimeSwitch: number;
  flipChance: number;
  /** 뉴스 첫 반응 뒤 따라붙을 확률 (나머지는 되돌림) */
  followChance: number;
  srLookback: number;
  srBand: number;
  srWeight: number;
  gradCap: number;
  gradPER: number;
  gradSuccesses: number;
  impactK: number;
  impactCap: Record<MarketKind, number>;
  impactTempShare: number;
  gradCooldown: number;
  splitPrice: number;
  delistCap: number;
  watchTicks: number;
  rescueOdds: [number, number];
  maxNewGrowth: number;
  /** 신흥주 소프트 상한 (시작가 대비 배수) */
  ventureCap: number;
  /** 신흥주 검증 성공 확률 */
  ventureSuccess: number;
  epsHalfLife: number;
  epsBand: [number, number];
}
