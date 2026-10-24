import type { AssetDef, SpareDef } from "./types.ts";

export const SECTORS: Record<string, string> = {
  semi: "반도체",
  bigtech: "빅테크",
  platform: "플랫폼",
  growth: "성장주",
  finance: "금융·결제",
  bio: "헬스케어",
  consumer: "소비재·유통",
  energy: "에너지",
  newgrowth: "신성장",
  crypto: "코인",
  venture: "신흥주",
  // 테마 업종 (2026-10-24): 종목의 주 업종과 별개로 themes에 들어간다. 업종 뉴스는 주 업종·테마 종목을 함께 움직인다
  ai: "AI",
  quantum: "양자컴퓨터",
  mobility: "모빌리티",
};

/**
 * 신흥주 기술 분야 → 테마 업종. 예비·새로 지어낸 신흥주도 이걸로 정한다 (맞는 게 없으면 성장주).
 * 앞에서부터 맞는 규칙을 모두 모은다
 */
const TECH_THEMES: [RegExp, string[]][] = [
  [/양자/, ["quantum", "semi"]],
  [/칩/, ["semi"]],
  [/배터리|전해질|전고체/, ["energy", "mobility"]],
  [/태양|핵융합|원자로|지열|송전|연료|발전|담수|수소|탄소|열에너지|폐기물/, ["energy"]],
  [/위성|우주|홀로그램|디스플레이/, ["bigtech"]],
  [/뇌|AI|로보|로봇|휴머노이드|뉴로모픽/, ["ai"]],
  [/유전자 치료|신약|단백질|뇌|바이오|헬스|치료제|신경|냉동 보존/, ["bio"]],
  [/열차|항공|모빌리티|드론|자율/, ["mobility"]],
  [/배양육|작물|플라스틱|식품|농장|농업|물 수확/, ["consumer"]],
];
export function themesOfTech(tech = ""): string[] {
  const out = new Set<string>();
  for (const [re, keys] of TECH_THEMES) if (re.test(tech)) keys.forEach(k => out.add(k));
  return out.size ? [...out] : ["growth"];
}

// 시즌 시작가·시총·적정 PER은 실제 미국 증시 시가총액 상위 20대 종목 밸류에이션을 기반으로 초기화.
// 주식만 적정 PER(fairPER)을 가지며, 코인은 PER 없이 시총·유동성만 가진다.
export const ASSETS: AssetDef[] = [
  // 기존 10개 미국 대형 기술·성장주
  { sym: "NVDA", name: "엔비디아", market: "stock", sector: "semi", price: 219.43, cap: 5.27e12, fairPER: 36.5, product: "AI 가속기", parValue: 1, themes: ["ai"] },
  { sym: "AMD", name: "AMD", market: "stock", sector: "semi", price: 172.66, cap: 2.8e11, fairPER: 31.2, product: "서버 CPU", parValue: 0.5 },
  { sym: "AAPL", name: "애플", market: "stock", sector: "bigtech", price: 242.1, cap: 3.64e12, fairPER: 31.8, product: "스마트폰", parValue: 1 },
  { sym: "MSFT", name: "마이크로소프트", market: "stock", sector: "bigtech", price: 534.24, cap: 3.95e12, fairPER: 33.4, product: "클라우드", parValue: 1, themes: ["ai", "quantum"] },
  { sym: "AMZN", name: "아마존", market: "stock", sector: "bigtech", price: 228.75, cap: 2.41e12, fairPER: 35.0, product: "물류·클라우드", parValue: 1 },
  { sym: "GOOGL", name: "알파벳", market: "stock", sector: "platform", price: 361.29, cap: 4.34e12, fairPER: 23.6, product: "검색 광고", parValue: 1, themes: ["quantum"] },
  { sym: "META", name: "메타", market: "stock", sector: "platform", price: 712.4, cap: 1.79e12, fairPER: 26.4, product: "광고 플랫폼", parValue: 1, themes: ["ai"] },
  { sym: "NFLX", name: "넷플릭스", market: "stock", sector: "platform", price: 1120.3, cap: 4.79e11, fairPER: 38.2, product: "스트리밍", parValue: 5 },
  { sym: "TSLA", name: "테슬라", market: "stock", sector: "growth", price: 405.12, cap: 1.3e12, fairPER: 88.5, product: "전기차", parValue: 1, themes: ["mobility"] },
  { sym: "PLTR", name: "팔란티어", market: "stock", sector: "growth", price: 148.9, cap: 3.51e11, fairPER: 96.0, product: "데이터 분석 소프트웨어", parValue: 0.5, themes: ["ai"] },
  // 추가 10개 미국 시가총액 상위 종목 (총 20종목)
  { sym: "AVGO", name: "브로드컴", market: "stock", sector: "semi", price: 236.4, cap: 1.11e12, fairPER: 34.8, product: "맞춤형 AI 칩·네트워크", parValue: 1 },
  { sym: "BRK", name: "버크셔 해서웨이", market: "stock", sector: "finance", price: 468.2, cap: 1.01e12, fairPER: 21.5, product: "보험·지주 포트폴리오", parValue: 5 },
  { sym: "LLY", name: "일라이 릴리", market: "stock", sector: "bio", price: 912.5, cap: 8.65e11, fairPER: 48.0, product: "비만·대사 치료제", parValue: 1 },
  { sym: "WMT", name: "월마트", market: "stock", sector: "consumer", price: 94.8, cap: 7.62e11, fairPER: 36.2, product: "글로벌 리테일·이커머스", parValue: 0.5 },
  { sym: "JPM", name: "JP모건 체이스", market: "stock", sector: "finance", price: 248.6, cap: 7.02e11, fairPER: 13.8, product: "글로벌 투자·상업은행", parValue: 1 },
  { sym: "V", name: "비자", market: "stock", sector: "finance", price: 318.9, cap: 6.32e11, fairPER: 29.5, product: "글로벌 결제 네트워크", parValue: 0.5 },
  { sym: "UNH", name: "유나이티드헬스", market: "stock", sector: "bio", price: 588.4, cap: 5.42e11, fairPER: 20.4, product: "헬스케어·보험 서비스", parValue: 1 },
  { sym: "XOM", name: "엑슨모빌", market: "stock", sector: "energy", price: 118.2, cap: 5.18e11, fairPER: 14.2, product: "원유·천연가스", parValue: 1 },
  { sym: "ORCL", name: "오라클", market: "stock", sector: "bigtech", price: 186.5, cap: 5.15e11, fairPER: 32.0, product: "클라우드 데이터베이스", parValue: 0.5, themes: ["ai"] },
  { sym: "COST", name: "코스트코", market: "stock", sector: "consumer", price: 978.0, cap: 4.34e11, fairPER: 52.4, product: "회원제 창고형 할인점", parValue: 1 },
  // 코인 5종 (PER 없음)
  { sym: "BTC", name: "비트코인", market: "coin", sector: "crypto", price: 94880.1, cap: 1.88e12, liquidity: 3e7 },
  { sym: "ETH", name: "이더리움", market: "coin", sector: "crypto", price: 3412.55, cap: 4.11e11, liquidity: 2e7 },
  { sym: "XRP", name: "리플", market: "coin", sector: "crypto", price: 2.48, cap: 1.42e11, liquidity: 1.5e7 },
  { sym: "SOL", name: "솔라나", market: "coin", sector: "crypto", price: 238.4, cap: 1.13e11, liquidity: 1.5e7 },
  { sym: "DOGE", name: "도지코인", market: "coin", sector: "crypto", price: 0.3121, cap: 4.58e10, liquidity: 8e6 },
  // 신흥주 10종
  { sym: "LMQ", name: "루미큐 양자", market: "venture", sector: "venture", price: 6.88, cap: 1.1e9, tech: "양자 오류 보정", parValue: 0.1 },
  { sym: "BNXT", name: "바이오넥스", market: "venture", sector: "venture", price: 2.14, cap: 4.2e8, tech: "유전자 치료", parValue: 0.1 },
  { sym: "ORBL", name: "오르빗랩", market: "venture", sector: "venture", price: 11.4, cap: 2.3e9, tech: "소형 위성 통신", parValue: 0.1 },
  { sym: "CLFG", name: "셀포지", market: "venture", sector: "venture", price: 0.92, cap: 1.5e8, tech: "전고체 배터리", parValue: 0.1 },
  { sym: "FUSN", name: "퓨전원", market: "venture", sector: "venture", price: 18.2, cap: 3.6e9, tech: "소형 핵융합", parValue: 0.1 },
  { sym: "NXRL", name: "넥스트레일", market: "venture", sector: "venture", price: 3.35, cap: 6.7e8, tech: "초고속 튜브 열차", parValue: 0.1 },
  { sym: "AQGN", name: "아쿠아젠", market: "venture", sector: "venture", price: 5.1, cap: 8.2e8, tech: "저전력 해수담수화", parValue: 0.1 },
  { sym: "MDBR", name: "마인드브릿지", market: "venture", sector: "venture", price: 9.75, cap: 1.9e9, tech: "비침습 뇌-컴퓨터 인터페이스", parValue: 0.1 },
  { sym: "SKPT", name: "스카이포트", market: "venture", sector: "venture", price: 1.62, cap: 2.6e8, tech: "도심 항공 모빌리티", parValue: 0.1 },
  { sym: "GRMT", name: "그린미트", market: "venture", sector: "venture", price: 4.48, cap: 7.1e8, tech: "배양육 대량 생산", parValue: 0.1 },
];

// 신흥주가 승격·상장폐지되면 이 목록에서 새로 상장한다 (가상 기업)
export const SPARES: SpareDef[] = [
  { sym: "HLXR", name: "헬릭스로보", tech: "휴머노이드 관절 모듈" },
  { sym: "PVSK", name: "페로솔라", tech: "페로브스카이트 태양전지" },
  { sym: "DPSE", name: "딥씨에너지", tech: "심해 지열 발전" },
  { sym: "AGBT", name: "아그리봇", tech: "자율 농업 로봇" },
  { sym: "KRYM", name: "크라이오메드", tech: "장기 냉동 보존" },
  { sym: "LUMX", name: "루멕스", tech: "광 컴퓨팅 칩" },
  // 시즌당 승격 10개를 채우려고 추가한 예비 가상 기업
  { sym: "QBRN", name: "큐브레인", tech: "뉴로모픽 칩" },
  { sym: "HYDX", name: "하이드록스", tech: "그린수소 전해조" },
  { sym: "SLRW", name: "솔라윙", tech: "성층권 태양광 드론" },
  { sym: "MCRF", name: "마이크로팜", tech: "수직 농장 자동화" },
  { sym: "NRVX", name: "너브엑스", tech: "신경 재생 치료제" },
  { sym: "ORCM", name: "오르카마린", tech: "해양 탄소 포집" },
  { sym: "PLSM", name: "플라즈믹스", tech: "플라즈마 폐기물 처리" },
  { sym: "VXLR", name: "복셀리얼", tech: "공중 홀로그램 디스플레이" },
  { sym: "TRMX", name: "테라믹스", tech: "지하 열에너지 저장" },
  { sym: "AERV", name: "에어로베일", tech: "대기 중 물 수확" },
];

/** 선물 최대 레버리지와 선택지 (SPEC 3장) */
export const LEVERAGE: Record<string, number[]> = {
  stock: [2, 3, 5, 10],
  coin: [2, 3, 5, 10],
  venture: [2, 3, 5, 10],
};
