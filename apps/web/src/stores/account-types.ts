// 내 계좌 응답 타입 (/api/me 등). stores/account.ts가 그대로 다시 내보낸다.
import type { Ref } from "vue";
import type { useMarket } from "./market";

export interface Fill { id: number; tick: number; at: number; sym: string; side: string; qty: number; price: number; fee: number; pnl?: number }
export interface FuturePos {
  id: number; sym: string; side: "long" | "short"; lev: number;
  qty: number; entry: number; margin: number; stop: number | null; tp: number | null; liq: number;
}
/** 걸어 둔 지정가. qty = 남은 수량, filled = 체결된 수량. kind fut이면 buy 롱 / sell 숏 진입 */
/** cash = 묶인 돈, held = 현물 매도로 떼어 둔 수량. 둘 다 총자산에 들어간다 */
/** reduce = 선물 종료 지정가 (posId 포지션만 줄인다) */
export interface OpenOrder { id: number; sym: string; kind: "spot" | "fut"; side: "buy" | "sell"; lev: number; price: number; qty: number; filled: number; cash: number; held: number; reduce?: boolean; posId?: number | null }
export interface Me {
  /** grad: 50배 졸업 금액, goal: 100배 전설 금액 */
  name: string; cash: number; equity: number; returnPct: number; goal: number; grad: number;
  clearedTick: number | null; gradTick: number | null; resetAt: number | null; tick: number;
  positions: { sym: string; qty: number; avg: number }[];
  futures: FuturePos[];
  fills: Fill[]; orders: OpenOrder[]; rank: number | null;
}

/** reason: rank(순위 LP)·out(51위 밖)·loss(손실)·late-reset(23시 이후 다시 시작)·dormant(휴면)·absent(불참) */
export interface Profile {
  lp: number; floor: number; rank: number | null; people: number;
  today: { delta: number; reason: string };
  history: { season: number; rank: number | null; delta: number; lp: number; reason: string }[];
}

/** 계좌 스토어가 넘겨 주는 것: 인증 붙은 요청, 토스트, 시세 스토어, 계좌 상태 */
export interface AccountCtx {
  api: <T>(path: string, body?: unknown) => Promise<T>;
  notify: (text: string, kind?: "ok" | "error") => void;
  m: ReturnType<typeof useMarket>;
  me: Ref<Me | null>;
  busy: Ref<boolean>;
  holdTab: Ref<"hold" | "fut" | "orders" | "fills">;
}
