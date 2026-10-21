import type { AssetDef, SpareDef } from "./types.ts";

export const SECTORS: Record<string, string> = {
  semi: "반도체",
  bigtech: "빅테크",
  platform: "플랫폼",
  growth: "성장주",
  newgrowth: "신성장",
  crypto: "코인",
  venture: "신흥주",
};

// 시즌 시작가. parValue: 액면가(주식 $0.5~5, 신흥주 $0.1, 코인 없음). fairPER: 시작가가 곧 적정가 (PER 약 10). 뉴스로 EPS가 바뀌면 적정가도 움직인다.
export const ASSETS: AssetDef[] = [
  { sym: "NVDA", name: "엔비디아", market: "stock", sector: "semi", price: 219.43, cap: 5.27e12, fairPER: 12, product: "AI 가속기", parValue: 1 },
  { sym: "AMD", name: "AMD", market: "stock", sector: "semi", price: 172.66, cap: 2.8e11, fairPER: 11, product: "서버 CPU", parValue: 0.5 },
  { sym: "AAPL", name: "애플", market: "stock", sector: "bigtech", price: 242.1, cap: 3.64e12, fairPER: 10, product: "스마트폰", parValue: 1 },
  { sym: "MSFT", name: "마이크로소프트", market: "stock", sector: "bigtech", price: 534.24, cap: 3.95e12, fairPER: 11, product: "클라우드", parValue: 1 },
  { sym: "AMZN", name: "아마존", market: "stock", sector: "bigtech", price: 228.75, cap: 2.41e12, fairPER: 10, product: "물류·클라우드", parValue: 1 },
  { sym: "GOOGL", name: "알파벳", market: "stock", sector: "platform", price: 361.29, cap: 4.34e12, fairPER: 10, product: "검색 광고", parValue: 1 },
  { sym: "META", name: "메타", market: "stock", sector: "platform", price: 712.4, cap: 1.79e12, fairPER: 9, product: "광고 플랫폼", parValue: 1 },
  { sym: "NFLX", name: "넷플릭스", market: "stock", sector: "platform", price: 1120.3, cap: 4.79e11, fairPER: 10, product: "스트리밍", parValue: 5 },
  { sym: "TSLA", name: "테슬라", market: "stock", sector: "growth", price: 405.12, cap: 1.3e12, fairPER: 12, product: "전기차", parValue: 1 },
  { sym: "PLTR", name: "팔란티어", market: "stock", sector: "growth", price: 148.9, cap: 3.51e11, fairPER: 12, product: "데이터 분석 소프트웨어", parValue: 0.5 },
  { sym: "BTC", name: "비트코인", market: "coin", sector: "crypto", price: 94880.1, liquidity: 3e7 },
  { sym: "ETH", name: "이더리움", market: "coin", sector: "crypto", price: 3412.55, liquidity: 2e7 },
  { sym: "DOGE", name: "도지코인", market: "coin", sector: "crypto", price: 0.3121, liquidity: 8e6 },
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
];

/** 선물 최대 레버리지와 선택지 (SPEC 3장) */
export const LEVERAGE: Record<string, number[]> = {
  stock: [2, 3, 5, 10],
  coin: [2, 3, 5],
  venture: [2, 3, 5],
};
