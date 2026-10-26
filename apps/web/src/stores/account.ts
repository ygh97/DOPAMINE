// 내 계좌: 참가(토큰), 보유종목, 선물 포지션, 체결 내역, 주문. 총자산은 실시간 시세로 화면에서 계산한다.
// 주문 동작은 account-trade.ts, 채팅·운영 동작은 account-social.ts, 타입은 account-types.ts (2026-10-27 나눔).
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { playFillSound } from "../sound";
import { useMarket } from "./market";
import { socialActions } from "./account-social";
import { tradeActions } from "./account-trade";
import type { Fill, Me, Profile } from "./account-types";

export type { Fill, FuturePos, Me, OpenOrder, Profile } from "./account-types";

const TOKEN_KEY = "dc-token";
const readToken = () => { try { return localStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; } };
const writeToken = (t: string) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* 저장 불가 환경 */ } };

export const useAccount = defineStore("account", () => {
  const m = useMarket();
  const token = ref(readToken());
  const me = ref<Me | null>(null);
  watch(() => me.value?.name, name => { m.myName = name ?? ""; }); // 귓속말 알림이 내 이름을 안다
  // 체결 알림음: 내 체결 내역에 새 체결이 생기면 (내 주문·걸어 둔 지정가·익절·손절·청산 모두) 한 번 "짤랑".
  // 처음 받은 내역은 소리 없이 기준으로만 삼는다
  let lastFillId: number | null = null;
  const BUY_SIDES = new Set(["buy", "long-open", "short-close"]);
  watch(() => me.value?.fills, fills => {
    if (!fills) { lastFillId = null; return; }
    const top = fills.reduce((m, f) => Math.max(m, f.id), 0);
    if (lastFillId != null && top > lastFillId) {
      const newest = fills.find(f => f.id === top)!;
      playFillSound(BUY_SIDES.has(newest.side));
    }
    lastFillId = Math.max(lastFillId ?? 0, top);
  });
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

  /** 내 개미 계급 프로필 (/api/profile): LP, 사람끼리 지금 순위, 지금 마감하면 바뀔 LP, 최근 정산 */
  const profile = ref<Profile | null>(null);
  async function loadProfile() {
    if (!token.value) { profile.value = null; return; }
    try { profile.value = await api<Profile>("/api/profile"); } catch { /* 다음에 다시 */ }
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

  const trade = tradeActions({ api, notify, m, me, busy, holdTab });

  /** 이번 시즌 한 종목의 내 체결 전부 (차트 B/S) */
  async function fetchFills(sym: string) {
    if (!token.value) return [];
    try { return (await api<{ fills: Fill[] }>(`/api/fills?sym=${encodeURIComponent(sym)}`)).fills; }
    catch { return []; }
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

  const social = socialActions({ api, notify, m });

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

  return { token, me, busy, profile, loadProfile, holdTab, toast, positions, futures, equity, holding, notify, refresh, join, logout, ...trade, fetchFills, fetchDrawings, syncDrawing, ...social };
});
