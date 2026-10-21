// 내 계좌: 참가(토큰), 보유종목, 체결 내역, 주문. 총자산은 실시간 시세로 화면에서 계산한다.
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { useMarket } from "./market";

const TOKEN_KEY = "dc-token";
const readToken = () => { try { return localStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; } };
const writeToken = (t: string) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* 저장 불가 환경 */ } };

export interface Fill { id: number; tick: number; at: number; sym: string; side: string; qty: number; price: number; fee: number }
export interface Me {
  name: string; cash: number; equity: number; returnPct: number; goal: number; clearedTick: number | null; resetAt: number | null;
  positions: { sym: string; qty: number; avg: number }[]; fills: Fill[]; rank: number | null;
}

export const useAccount = defineStore("account", () => {
  const m = useMarket();
  const token = ref(readToken());
  const me = ref<Me | null>(null);
  const busy = ref(false);
  const toast = ref<{ text: string; kind: "ok" | "error"; id: number } | null>(null);

  function notify(text: string, kind: "ok" | "error" = "ok") {
    const id = Date.now();
    toast.value = { text, kind, id };
    setTimeout(() => { if (toast.value?.id === id) toast.value = null; }, 3500);
  }

  async function api<T>(path: string, body?: unknown): Promise<T> {
    const r = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token.value ? { Authorization: `Bearer ${token.value}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) { token.value = ""; writeToken(""); me.value = null; }
    if (!r.ok) throw new Error(data.error ?? `요청 실패 (${r.status})`);
    return data as T;
  }

  async function refresh() {
    if (!token.value) return;
    try { me.value = await api<Me>("/api/me"); } catch { /* 401이면 api가 정리 */ }
  }

  async function join(name: string, password: string) {
    busy.value = true;
    try {
      const r = await api<{ token: string; name: string; created: boolean; me: Me }>("/api/join", { name, password });
      token.value = r.token; writeToken(r.token); me.value = r.me;
      void m.loadRanking(); // 랭킹에 바로 보이게
      notify(r.created ? `${r.name}님, 참가를 환영합니다. $100,000으로 시작합니다.` : `${r.name}님, 다시 오셨네요.`);
    } catch (e) { notify((e as Error).message, "error"); }
    finally { busy.value = false; }
  }

  async function logout() {
    await api("/api/logout", {}).catch(() => {});
    token.value = ""; writeToken(""); me.value = null;
  }

  async function order(sym: string, side: "buy" | "sell", pct: number) {
    busy.value = true;
    try {
      const r = await api<{ fill: Fill; me: Me }>("/api/order", { sym, side, pct });
      me.value = r.me;
      void m.loadRanking();
      const f = r.fill;
      notify(`${f.sym} ${f.side === "buy" ? "매수" : "매도"} ${+f.qty.toFixed(6)}${m.quotes[f.sym]?.market === "coin" ? "" : "주"} @ $${f.price.toFixed(f.price < 1 ? 4 : 2)}`);
    } catch (e) { notify((e as Error).message, "error"); }
    finally { busy.value = false; }
  }

  async function reset() {
    try { me.value = (await api<{ me: Me }>("/api/reset", { confirm: true })).me; notify("$100,000부터 다시 시작합니다."); }
    catch (e) { notify((e as Error).message, "error"); }
  }

  // 실시간 평가: 서버가 준 보유 수량 × 지금 시세
  const positions = computed(() => (me.value?.positions ?? []).map(p => {
    const price = m.quotes[p.sym]?.price ?? 0;
    const value = p.qty * price, cost = p.qty * p.avg;
    return { ...p, price, value, pnl: value - cost, pnlPct: cost ? (value / cost - 1) * 100 : 0, name: m.quotes[p.sym]?.name ?? p.sym };
  }));
  const equity = computed(() => (me.value ? me.value.cash + positions.value.reduce((s, p) => s + p.value, 0) : 0));
  const holding = (sym: string) => me.value?.positions.find(p => p.sym === sym)?.qty ?? 0;

  // 내가 가진 종목이 병합·폐지로 정산되면 계좌를 다시 받는다
  watch(() => m.settled, list => { if (list.some(s => holding(s.sym) > 0)) void refresh(); });
  // 새 시즌: 계좌가 $100,000으로 새로 생긴다
  watch(() => m.seasonEpoch, () => { void refresh(); notify("새 시즌이 시작됐습니다. 모두 $100,000부터 다시!"); });
  // 재연결하면 놓친 체결·정산을 반영
  watch(() => m.connected, on => { if (on) void refresh(); });

  return { token, me, busy, toast, positions, equity, holding, notify, refresh, join, logout, order, reset };
});
