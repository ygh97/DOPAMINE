// 내 계좌: 참가(토큰), 보유종목, 선물 포지션, 체결 내역, 주문. 총자산은 실시간 시세로 화면에서 계산한다.
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { useMarket } from "./market";

const TOKEN_KEY = "dc-token";
const readToken = () => { try { return localStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; } };
const writeToken = (t: string) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* 저장 불가 환경 */ } };

export interface Fill { id: number; tick: number; at: number; sym: string; side: string; qty: number; price: number; fee: number; pnl?: number }
export interface FuturePos {
  id: number; sym: string; side: "long" | "short"; lev: number;
  qty: number; entry: number; margin: number; stop: number | null; tp: number | null; liq: number;
}
/** 걸어 둔 지정가. qty = 남은 수량, filled = 체결된 수량. kind fut이면 buy 롱 / sell 숏 진입 */
/** cash = 묶인 돈, held = 현물 매도로 떼어 둔 수량. 둘 다 총자산에 들어간다 */
export interface OpenOrder { id: number; sym: string; kind: "spot" | "fut"; side: "buy" | "sell"; lev: number; price: number; qty: number; filled: number; cash: number; held: number }
export interface Me {
  /** grad: 20배 졸업 금액, goal: 100배 전설 금액 */
  name: string; cash: number; equity: number; returnPct: number; goal: number; grad: number;
  clearedTick: number | null; gradTick: number | null; resetAt: number | null; tick: number;
  positions: { sym: string; qty: number; avg: number }[];
  futures: FuturePos[];
  fills: Fill[]; orders: OpenOrder[]; rank: number | null;
}

export const useAccount = defineStore("account", () => {
  const m = useMarket();
  const token = ref(readToken());
  const me = ref<Me | null>(null);
  const busy = ref(false);
  const holdTab = ref<"hold" | "fut" | "orders" | "fills">("hold");
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

  function syncTab(next: Me | null) {
    if (!next) return;
    if (holdTab.value === "hold" && !next.positions.length && next.futures.length) holdTab.value = "fut";
    else if (holdTab.value === "fut" && !next.futures.length && next.positions.length) holdTab.value = "hold";
  }

  async function refresh() {
    if (!token.value) return;
    try { me.value = await api<Me>("/api/me"); syncTab(me.value); } catch { /* 401이면 api가 정리 */ }
  }

  async function join(name: string, password: string) {
    busy.value = true;
    try {
      const r = await api<{ token: string; name: string; created: boolean; me: Me }>("/api/join", { name, password });
      token.value = r.token; writeToken(r.token); me.value = r.me; syncTab(r.me);
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
      if (side === "buy") holdTab.value = "hold";
      void m.loadRanking();
      m.bookEpoch++;
      const f = r.fill;
      notify(`${f.sym} ${f.side === "buy" ? "매수" : "매도"} ${+f.qty.toFixed(6)}${m.quotes[f.sym]?.market === "coin" ? "" : "주"} @ $${f.price.toFixed(f.price < 1 ? 4 : 2)}`);
    } catch (e) { notify((e as Error).message, "error"); }
    finally { busy.value = false; }
  }

  async function openFuture(sym: string, side: "long" | "short", lev: number, pct: number) {
    busy.value = true;
    try {
      const r = await api<{ fill: Fill; me: Me }>("/api/futures/open", { sym, side, lev, pct });
      me.value = r.me;
      holdTab.value = "fut";
      void m.loadRanking();
      m.bookEpoch++;
      const f = r.fill;
      notify(`${f.sym} ${lev}x ${side === "long" ? "롱" : "숏"} 진입 ${+f.qty.toFixed(6)}${m.quotes[f.sym]?.market === "coin" ? "" : "주"} @ $${f.price.toFixed(f.price < 1 ? 4 : 2)}`);
    } catch (e) { notify((e as Error).message, "error"); }
    finally { busy.value = false; }
  }

  /** 지정가: 바로 체결된 몫은 체결 내역에, 남은 수량은 미체결 탭에 */
  async function limit(req: { sym: string; kind: "spot" | "fut"; side: "buy" | "sell"; price: number; pct: number; lev?: number }) {
    busy.value = true;
    try {
      const r = await api<{ fills: Fill[]; order: OpenOrder | null; me: Me }>("/api/limit", req);
      me.value = r.me;
      void m.loadRanking();
      const filled = r.fills.reduce((s, f) => s + f.qty, 0), unitOf = m.quotes[req.sym]?.market === "coin" ? "" : "주";
      const what = req.kind === "fut" ? `${req.lev}x ${req.side === "buy" ? "롱" : "숏"}` : req.side === "buy" ? "매수" : "매도";
      if (r.order) {
        holdTab.value = "orders"; // 남은 수량이 걸렸다
        notify(`${req.sym} ${what} 지정가 $${r.order.price.toFixed(r.order.price < 1 ? 4 : 2)} 걸어 둠${filled ? ` (${+filled.toFixed(6)}${unitOf} 바로 체결)` : ""}`);
      } else {
        if (req.kind === "fut") holdTab.value = "fut"; else if (req.side === "buy") holdTab.value = "hold"; // 전부 바로 체결
        notify(`${req.sym} ${what} 지정가 바로 체결 ${+filled.toFixed(6)}${unitOf}`);
      }
      m.bookEpoch++;
    } catch (e) { notify((e as Error).message, "error"); }
    finally { busy.value = false; }
  }

  async function cancel(id?: number) {
    try {
      const r = await api<{ count: number; me: Me }>("/api/cancel", id == null ? { all: true } : { id });
      me.value = r.me;
      notify(id == null ? `미체결 ${r.count}건을 모두 취소했습니다.` : "주문을 취소했습니다.");
      m.bookEpoch++;
    } catch (e) { notify((e as Error).message, "error"); }
  }

  async function closeFuture(posId: number, pct: number) {
    busy.value = true;
    try {
      const r = await api<{ fill: Fill; me: Me }>("/api/futures/close", { posId, pct });
      me.value = r.me;
      void m.loadRanking();
      const f = r.fill, pnl = f.pnl ?? 0;
      const pnlText = ` (${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(2)})`;
      notify(`${f.sym} 선물 ${pct >= 100 ? "종료" : `${pct}% 종료`} @ $${f.price.toFixed(f.price < 1 ? 4 : 2)}${pnlText}`);
    } catch (e) { notify((e as Error).message, "error"); }
    finally { busy.value = false; }
  }

  async function closeAll(scope: "spot" | "futures" | "all" = "all") {
    busy.value = true;
    try {
      const r = await api<{ count: number; fills: Fill[]; me: Me }>("/api/close-all", { scope });
      me.value = r.me;
      void m.loadRanking();
      const totalPnl = r.fills.reduce((s, f) => s + (f.pnl ?? 0), 0);
      const label = scope === "spot" ? "현물 일괄매도" : scope === "futures" ? "선물 일괄종료" : "전 포지션 일괄청산";
      notify(`${label} ${r.count}건 완료 (${totalPnl >= 0 ? "+" : "-"}$${Math.abs(totalPnl).toFixed(2)})`);
    } catch (e) { notify((e as Error).message, "error"); }
    finally { busy.value = false; }
  }

  async function setStop(posId: number, price: number | null) {
    try {
      const r = await api<{ me: Me }>("/api/stop", { posId, price });
      me.value = r.me;
      notify(price == null ? "스탑로스를 해제했습니다." : `스탑로스 $${price.toFixed(price < 1 ? 4 : 2)} 설정`);
    } catch (e) { notify((e as Error).message, "error"); }
  }

  async function setTp(posId: number, price: number | null) {
    try {
      const r = await api<{ me: Me }>("/api/tp", { posId, price });
      me.value = r.me;
      notify(price == null ? "익절가를 해제했습니다." : `익절가 $${price.toFixed(price < 1 ? 4 : 2)} 설정`);
    } catch (e) { notify((e as Error).message, "error"); }
  }

  async function reset() {
    try { me.value = (await api<{ me: Me }>("/api/reset", { confirm: true })).me; notify("$100,000부터 다시 시작합니다."); }
    catch (e) { notify((e as Error).message, "error"); }
  }

  async function fetchDrawings() {
    if (!token.value) return null;
    try { return (await api<{ drawings: Record<string, { factor: number; items: unknown[] }> }>("/api/drawings")).drawings; }
    catch { return null; }
  }

  function syncDrawing(p: { sym: string; factor: number; items: unknown[] }) {
    if (!token.value) return;
    void api("/api/drawings", p).catch(() => {});
  }

  async function postChat(path: string, body: unknown): Promise<boolean> {
    try {
      const r = await api<{ msg: { id: number; name: string; text: string; at: number } }>(path, body);
      if (!m.chat.some(c => c.id === r.msg.id)) m.chat.push(r.msg);
      return true;
    } catch (e) { notify((e as Error).message, "error"); return false; }
  }
  const sendChat = (text: string) => postChat("/api/chat", { text });
  /** "[공유]" 수익인증. 문구는 서버가 실제 계좌 값으로 만든다 */
  const share = (req: { type: "spot" | "fut" | "fill" | "summary"; sym?: string; id?: number }) => postChat("/api/chat/share", req);
  /** 강제청산 알림에 티배깅·묵념 (알림 1건당 처음 누른 한 명만) */
  async function react(liqId: number, mode: "teabag" | "rip") {
    const ok = await postChat("/api/chat/react", { liqId, mode });
    m.markReacted(liqId); // 성공이든 "이미 누군가 반응"이든 버튼은 내린다
    return ok;
  }

  async function reportChat(id: number) {
    try {
      const r = await api<{ id: number; reports: number; hidden: boolean }>("/api/chat/report", { id });
      notify(r.hidden ? "신고 누적으로 메시지가 숨김 처리됐습니다." : `신고가 접수됐습니다 (${r.reports}/3)`);
    } catch (e) { notify((e as Error).message, "error"); }
  }

  async function adminApi<T>(key: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), "x-admin-key": key },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error ?? `요청 실패 (${r.status})`);
    return data as T;
  }

  const adminChat = (key: string) => adminApi<{ messages: { id: number; name: string; text: string; at: number; reports: number; hidden: boolean }[]; banned: string[] }>(key, "/api/admin/chat");
  const adminBan = (key: string, name: string, banned: boolean) => adminApi(key, "/api/admin/ban", { name, banned });
  const adminHide = (key: string, id: number, hidden: boolean) => adminApi(key, "/api/admin/hide", { id, hidden });

  // 실시간 평가: 서버가 준 보유 수량·선물 포지션 × 지금 시세
  const positions = computed(() => (me.value?.positions ?? []).map(p => {
    const price = m.quotes[p.sym]?.price ?? 0;
    const value = p.qty * price, cost = p.qty * p.avg;
    return { ...p, price, value, pnl: value - cost, pnlPct: cost ? (value / cost - 1) * 100 : 0, name: m.quotes[p.sym]?.name ?? p.sym };
  }));
  const futures = computed(() => (me.value?.futures ?? []).map(f => {
    const price = m.quotes[f.sym]?.price ?? f.entry;
    const pnl = (f.side === "long" ? 1 : -1) * f.qty * (price - f.entry);
    const value = Math.max(0, f.margin + pnl);
    return { ...f, price, value, pnl, pnlPct: f.margin ? (pnl / f.margin) * 100 : 0, name: m.quotes[f.sym]?.name ?? f.sym };
  }));
  // 지정가에 묶인 돈·수량도 내 돈이다 (안 넣으면 지정가를 걸 때마다 총자산이 줄어 보인다)
  const locked = computed(() => (me.value?.orders ?? []).reduce((s, o) => s + o.cash + o.held * (m.quotes[o.sym]?.price ?? o.price), 0));
  const equity = computed(() => (me.value
    ? me.value.cash + locked.value + positions.value.reduce((s, p) => s + p.value, 0) + futures.value.reduce((s, f) => s + f.value, 0)
    : 0));
  const holding = (sym: string) => me.value?.positions.find(p => p.sym === sym)?.qty ?? 0;
  const hasExposure = (sym: string) => holding(sym) > 0 || (me.value?.futures.some(f => f.sym === sym) ?? false) || (me.value?.orders.some(o => o.sym === sym) ?? false);

  // 내가 가진 종목이 병합·폐지·강제청산·스탑로스로 정산되거나 내 지정가가 체결되면 계좌를 다시 받는다
  watch(() => m.settled, async list => {
    if (!list.some(s => hasExposure(s.sym))) return;
    const prevId = me.value?.fills[0]?.id ?? 0;
    await refresh();
    const latest = me.value?.fills[0];
    // 걸어 둔 지정가가 체결됐다: 현물 매수면 보유종목, 선물 진입이면 선물 포지션 탭으로
    if (list.some(s => s.type === "order")) {
      const fresh = (me.value?.fills ?? []).filter(f => f.id > prevId);
      if (fresh.some(f => f.side.endsWith("-open"))) holdTab.value = "fut";
      else if (fresh.some(f => f.side === "buy")) holdTab.value = "hold";
    }
    if (latest && latest.id > prevId) {
      if (latest.side === "liquidation") notify(`${latest.sym} 선물 포지션이 강제 청산됐습니다.`, "error");
      else if (latest.side === "stop") notify(`${latest.sym} 스탑로스가 체결됐습니다.`);
      else if (latest.side === "tp") notify(`${latest.sym} 목표 익절가가 체결됐습니다!`);
    }
  });
  // 새 시즌: 계좌가 $100,000으로 새로 생긴다
  watch(() => m.seasonEpoch, () => { void refresh(); notify("새 시즌이 시작됐습니다. 모두 $100,000부터 다시!"); });
  // 재연결하면 놓친 체결·정산을 반영
  watch(() => m.connected, on => { if (on) void refresh(); });

  return { token, me, busy, holdTab, toast, positions, futures, equity, holding, notify, refresh, join, logout, order, openFuture, limit, cancel, closeFuture, closeAll, setStop, setTp, reset, fetchDrawings, syncDrawing, sendChat, share, react, reportChat, adminChat, adminBan, adminHide };
});
