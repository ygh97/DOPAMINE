// 시세·뉴스 상태. 접속 시 /api/snapshot 한 번, 이후 /api/stream(SSE)으로 변경분만 받는다.
// Cloudflare Quick Tunnel(*.trycloudflare.com)처럼 무한 SSE 스트림을 버퍼링하는 프록시에서는 자동으로 /api/poll(1초 폴링)로 전환한다.
import type { AnalystView, Consensus, GameDate, MarketKind, NewsItem, Quote, Upcoming } from "@dopamine/engine";
import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import { playWhisperDing } from "../sound";

/** user: 사람, bot: 🤖 봇, mm: 🏦 세력, whale: 🐋 고래 */
export type AccountKind = "user" | "bot" | "mm" | "whale";
/** gradTick: 20배 졸업, clearedTick: 100배 전설 */
export interface RankRow { rank: number; name: string; kind?: AccountKind; equity: number; returnPct: number; clearedTick: number | null; gradTick?: number | null }
/** reacted: 강제청산 알림에 누군가 이미 티배깅·묵념을 했다 (버튼을 숨긴다) */
export interface ChatMsg { id: number; name: string; text: string; at: number; to?: string | null; reacted?: boolean; loud?: boolean }
export const kindBadge = (k?: AccountKind) => (k === "bot" ? "🤖" : k === "mm" ? "🏦" : k === "whale" ? "🐋" : "");
export interface OrderPreset { mode: "spot" | "fut"; side: "buy" | "sell"; lev?: number; seq: number }
/** 서버가 보내는 압축 봉: [timestamp, open, high, low, close, volume] */
export type PackedBar = [number, number, number, number, number, number];
/** 이름별 배지: 시즌 엠블럼(100배 전설)과 TOP 3 메달 (/api/badges) */
export interface Badges { emblems: { season: number; icon: string }[]; medals: { season: number; rank: number }[] }
/** 일정·애널리스트·보고 있는 종목의 의견 분포 (/api/research) */
export interface Research { tick: number; upcoming: Upcoming[]; analysts: AnalystView[]; consensus: Consensus | null }
interface TickEvent { tick: number; date: GameDate; bars: Record<string, [...PackedBar, number]> }

export const useMarket = defineStore("market", () => {
  const quotes = ref<Record<string, Quote>>({});
  const sectors = ref<Record<string, string>>({});
  const date = ref<GameDate>({ year: 0, month: 0, day: 0 });
  const news = ref<NewsItem[]>([]);
  const tick = ref(0);
  const connected = ref(false);
  /** 직전 tick 대비 방향 (+1, -1, 0). 시세 셀 깜빡임에 쓴다 */
  const direction = ref<Record<string, number>>({});
  /** 최신 1분봉. 차트가 tick마다 이어 붙인다 */
  const lastBars = shallowRef<Record<string, PackedBar>>({});
  /** 주식병합처럼 과거 봉이 바뀌면 올라간다. 차트가 보고 다시 받는다 */
  const barsEpoch = ref<Record<string, number>>({});
  /** 시즌 랭킹 (5 tick마다) */
  const ranking = ref<RankRow[]>([]);
  const players = ref(0);
  /** 🏦 세력 계정 (수익률 순, 랭킹과 따로) */
  const mmRanking = ref<RankRow[]>([]);
  /** 🐋 고래 (별도 탭) */
  const whaleRanking = ref<RankRow[]>([]);
  /** 진행 중 시즌. 시즌이 바뀌면 seasonEpoch가 올라가고 차트·계좌가 새로 받는다 */
  const season = ref<{ id: number; startedAt: number; endsAt: number } | null>(null);
  const seasonEpoch = ref(0);
  /** 마지막으로 병합·폐지 정산된 종목들. 계좌 스토어가 보고 내 보유와 겹치면 계좌를 다시 받는다 */
  const settled = ref<{ type: string; sym: string }[]>([]);
  const chat = ref<ChatMsg[]>([]);
  const banner = ref<{ id: number; text: string; kind: "clear" | "liq" } | null>(null);
  const whisperAlert = ref<{ id: number; from: string; text: string } | null>(null);
  const unreadWhispers = ref(0);
  const replyWhisperTo = ref<string | null>(null);
  let lastBannerId = 0;
  let lastWhisperId = 0;
  function checkBanner(msg: ChatMsg) {
    if (msg.name === "⚡전광판" && msg.text.startsWith("[전설]")) void loadBadges(); // 새 전설: 엠블럼이 바로 붙게
    if (msg.to && msg.id > lastWhisperId) {
      const myName = (() => { try { return (localStorage.getItem("dc-name") ?? "").toLowerCase(); } catch { return ""; } })();
      if (myName && msg.to.toLowerCase() === myName && msg.name.toLowerCase() !== myName) {
        lastWhisperId = msg.id;
        whisperAlert.value = { id: msg.id, from: msg.name, text: msg.text };
        if (socialTab.value !== "chat") unreadWhispers.value++;
        if (Date.now() - msg.at < 15_000) playWhisperDing(); // 접속 때 받는 지난 귓속말에는 울리지 않는다
        setTimeout(() => { if (whisperAlert.value?.id === msg.id) whisperAlert.value = null; }, 8000);
      }
    }
    if (msg.name !== "⚡전광판" || msg.id <= lastBannerId || msg.reacted) return;
    lastBannerId = msg.id;
    const myName = (() => { try { return localStorage.getItem("dc-name") ?? ""; } catch { return ""; } })();
    if (!msg.loud && !(myName && msg.text.includes(` ${myName}님`))) return; // 작은 봇 청산은 채팅에만
    const kind: "clear" | "liq" = msg.text.startsWith("[강제청산]") ? "liq" : "clear"; // 졸업·전설(예전 100배졸업 포함)
    const text = msg.text.replace(/^\[(졸업|전설|100배졸업|강제청산)\]\s*/, "");
    bannerQueue.push({ id: msg.id, text, kind });
    if (bannerQueue.length > 3) bannerQueue.shift(); // 밀리면 오래된 것부터 버린다
    if (!bannerBusy) showNextBanner();
  }
  // 전광판은 LIVE 바 자리에 6초 뜨고, 다음 알림 전에 뉴스가 최소 4초는 보이게 쉰다
  const bannerQueue: { id: number; text: string; kind: "clear" | "liq" }[] = [];
  let bannerBusy = false;
  function showNextBanner() {
    const next = bannerQueue.shift();
    if (!next) { bannerBusy = false; return; }
    bannerBusy = true;
    banner.value = next;
    setTimeout(() => {
      if (banner.value?.id === next.id) banner.value = null;
      setTimeout(showNextBanner, 4000);
    }, 6000);
  }

  const tab = ref<MarketKind>("stock");
  const selected = ref("NVDA");
  const newsDialog = ref<{ mode: "detail"; id: string } | { mode: "list"; sym?: string } | null>(null);
  const floatingNewsOpen = ref((() => { try { return localStorage.getItem("dc-float-news") === "1"; } catch { return false; } })());
  function toggleFloatingNews(force?: boolean) {
    floatingNewsOpen.value = force ?? !floatingNewsOpen.value;
    try { localStorage.setItem("dc-float-news", floatingNewsOpen.value ? "1" : "0"); } catch { /* ignore */ }
  }
  const guideOpen = ref(false);
  const spyTarget = ref<string | null>(null);
  const orderPreset = ref<OrderPreset | null>(null);
  const socialTab = ref<"chat" | "rank" | "mm" | "whale" | "hall" | "analyst">("rank");
  const research = ref<Research | null>(null);
  const badges = ref<Record<string, Badges>>({});
  async function loadBadges() {
    try { const r = await fetch("/api/badges"); if (r.ok) badges.value = await r.json(); } catch { /* 다음에 다시 */ }
  }
  /** 1등 메달이 하나라도 있으면 채팅·랭킹 이름을 금색으로 */
  const isChamp = (name: string) => !!badges.value[name]?.medals.some(x => x.rank === 1);
  const calendarOpen = ref(false);
  async function loadResearch() {
    try {
      const r = await fetch(`/api/research?sym=${encodeURIComponent(selected.value)}`);
      if (r.ok) research.value = await r.json();
    } catch { /* 다음에 다시 */ }
  }
  /** 호가창에서 누른 가격 → 주문 패널이 지정가로 받는다 */
  const bookPick = ref<{ price: number; seq: number } | null>(null);
  /** 종목을 누를 때마다 올린다. 이미 보고 있는 종목을 다시 눌러도 차트가 최신 봉으로 간다 */
  const chartJump = ref(0);
  /** 내 주문 직후 올린다. 호가창이 다음 1초를 기다리지 않고 다시 받는다 */
  const bookEpoch = ref(0);

  const list = computed(() => Object.values(quotes.value).filter(q => q.market === tab.value));
  const current = computed<Quote | null>(() => quotes.value[selected.value] ?? null);

  function applyQuotes(next: Quote[]) {
    quotes.value = Object.fromEntries(next.map(q => [q.sym, q]));
    // 보고 있던 종목이 상장폐지되면 같은 탭의 첫 종목으로, 승격되면 탭을 따라간다
    const cur = quotes.value[selected.value];
    if (!cur) selected.value = (list.value[0] ?? next[0]).sym;
    else tab.value = cur.market;
  }

  function applyTick(d: TickEvent) {
    const dir: Record<string, number> = {}, bars: Record<string, PackedBar> = {};
    for (const [sym, packed] of Object.entries(d.bars)) {
      const q = quotes.value[sym];
      if (!q) continue;
      const [ts, o, h, l, c, v, prev] = packed;
      const k = c / q.price;
      dir[sym] = Math.sign(c - q.price);
      // EPS·발행 주식 수는 tick 사이에 그대로라 가격 비율로 PER·시총을 갱신
      q.price = c; q.prev = prev;
      if (q.per) q.per *= k;
      if (q.cap) q.cap *= k;
      bars[sym] = [ts, o, h, l, c, v];
    }
    direction.value = dir;
    lastBars.value = bars;
    date.value = d.date;
    tick.value = d.tick;
  }

  async function loadSnapshot() {
    const tok = (() => { try { return localStorage.getItem("dc-token") ?? ""; } catch { return ""; } })();
    const s = await (await fetch("/api/snapshot", tok ? { headers: { Authorization: `Bearer ${tok}` } } : undefined)).json();
    sectors.value = s.sectors;
    if (season.value && season.value.id !== s.season.id) seasonEpoch.value++; // 재연결 사이에 시즌이 바뀜
    season.value = s.season;
    date.value = s.date;
    tick.value = s.tick;
    news.value = s.news;
    if (Array.isArray(s.chat)) {
      chat.value = s.chat;
      lastBannerId = s.chat.at(-1)?.id ?? 0;
      lastWhisperId = s.chat.at(-1)?.id ?? 0;
    }
    applyQuotes(s.quotes);
    void loadBadges();
    await loadRanking();
  }

  // 귓속말은 SSE에 내용이 안 실린다. 신호가 오면 로그인한 사람만 본인 몫을 받아 온다
  async function loadWhispers() {
    const tok = (() => { try { return localStorage.getItem("dc-token") ?? ""; } catch { return ""; } })();
    if (!tok) return;
    try {
      const r = await fetch("/api/chat", { headers: { Authorization: `Bearer ${tok}` } });
      if (!r.ok) return;
      for (const c of (await r.json()).messages as ChatMsg[]) {
        if (!c.to || chat.value.some(x => x.id === c.id)) continue;
        chat.value.push(c);
        checkBanner(c);
      }
      chat.value.sort((a, b) => a.id - b.id);
    } catch { /* 다음 신호 때 다시 */ }
  }

  let source: EventSource | null = null;
  let lastMessageAt = 0, watchdog = 0, pollTimer = 0;

  function startPolling() {
    source?.close(); source = null;
    clearInterval(watchdog);
    clearInterval(pollTimer);
    void loadSnapshot().then(() => { connected.value = true; }).catch(() => { connected.value = false; });
    pollTimer = window.setInterval(async () => {
      try {
        const tok = (() => { try { return localStorage.getItem("dc-token") ?? ""; } catch { return ""; } })();
        const r = await fetch(`/api/poll?tick=${tick.value}`, tok ? { headers: { Authorization: `Bearer ${tok}` } } : undefined);
        if (!r.ok) { connected.value = false; return; }
        const d = await r.json();
        connected.value = true;
        if (season.value && d.season && season.value.id !== d.season.id) {
          await loadSnapshot();
          return;
        }
        if (d.assets) {
          applyQuotes(d.assets.quotes);
          for (const sym of d.assets.reload) barsEpoch.value[sym] = (barsEpoch.value[sym] ?? 0) + 1;
        }
        if (d.tick > tick.value) applyTick(d);
        if (Array.isArray(d.news) && d.news.length) {
          for (const n of d.news) {
            if (!news.value.some(x => x.id === n.id)) news.value.unshift(n);
          }
          if (news.value.length > 300) news.value.length = 300;
        }
        if (Array.isArray(d.chat)) {
          for (const c of d.chat as ChatMsg[]) {
            if (!chat.value.some(x => x.id === c.id)) chat.value.push(c);
            else if (c.reacted) markReacted(c.id); // 폴링에는 chat-react 신호가 없어 표시로 맞춘다
            checkBanner(c);
          }
        }
        if (d.ranking) applyRanking(d.ranking);
        if (Array.isArray(d.settled) && d.settled.length) settled.value = d.settled;
      } catch {
        connected.value = false;
      }
    }, 1000);
  }

  // 일정·애널리스트는 천천히 바뀐다: 10초마다
  if (typeof window !== "undefined") window.setInterval(() => { if (document.visibilityState === "visible") void loadResearch(); }, 10_000);
  if (typeof window !== "undefined") window.setInterval(() => { if (document.visibilityState === "visible") void loadBadges(); }, 60_000);

  function connect() {
    if (typeof location !== "undefined" && location.hostname.endsWith(".trycloudflare.com")) {
      startPolling();
      return;
    }
    source?.close();
    source = new EventSource("/api/stream");
    lastMessageAt = Date.now();
    source.onopen = () => { connected.value = true; void loadSnapshot(); void loadResearch(); }; // 재연결 시 놓친 상태 회복
    source.onerror = () => { connected.value = false; };
    // 프록시가 끊긴 연결을 닫아 주지 않는 경우가 있어, tick이 5초 넘게 없으면 직접 다시 연결
    clearInterval(watchdog);
    watchdog = window.setInterval(() => {
      if (Date.now() - lastMessageAt < 5000) return;
      connected.value = false;
      connect();
    }, 2000);
    source.addEventListener("tick", e => {
      lastMessageAt = Date.now();
      applyTick(JSON.parse((e as MessageEvent).data));
    });
    source.addEventListener("news", e => {
      news.value.unshift(JSON.parse((e as MessageEvent).data));
      if (news.value.length > 300) news.value.pop();
    });
    source.addEventListener("season", () => { void loadSnapshot(); });
    source.addEventListener("ranking", e => applyRanking(JSON.parse((e as MessageEvent).data)));
    source.addEventListener("settled", e => { settled.value = JSON.parse((e as MessageEvent).data); });
    source.addEventListener("chat", e => {
      const msg: ChatMsg = JSON.parse((e as MessageEvent).data);
      if (!chat.value.some(c => c.id === msg.id)) chat.value.push(msg);
      checkBanner(msg);
      if (chat.value.length > 300) chat.value.shift();
    });
    source.addEventListener("whisper", () => { void loadWhispers(); });
    source.addEventListener("chat-react", e => markReacted((JSON.parse((e as MessageEvent).data) as { id: number }).id));
    source.addEventListener("chat-hide", e => {
      const { id } = JSON.parse((e as MessageEvent).data) as { id: number };
      chat.value = chat.value.filter(c => c.id !== id);
    });
    source.addEventListener("chat-purge", e => {
      const { name } = JSON.parse((e as MessageEvent).data) as { name: string };
      chat.value = chat.value.filter(c => c.name !== name);
    });
    source.addEventListener("assets", e => {
      const d: { quotes: Quote[]; reload: string[] } = JSON.parse((e as MessageEvent).data);
      applyQuotes(d.quotes);
      for (const sym of d.reload) barsEpoch.value[sym] = (barsEpoch.value[sym] ?? 0) + 1;
    });
  }

  function applyRanking(d: { rows: RankRow[]; players: number; mm?: RankRow[]; whales?: RankRow[] }) {
    ranking.value = d.rows; players.value = d.players; mmRanking.value = d.mm ?? []; whaleRanking.value = d.whales ?? [];
  }
  /** 강제청산 알림에 누군가 반응함 → 버튼 숨김 (전광판 배너도) */
  function markReacted(id: number) {
    const c = chat.value.find(x => x.id === id);
    if (c) c.reacted = true;
    if (banner.value?.id === id) banner.value = null;
  }
  async function loadRanking() { applyRanking(await (await fetch("/api/ranking")).json()); }

  async function fetchBars(sym: string): Promise<PackedBar[]> {
    const r = await fetch(`/api/bars?sym=${encodeURIComponent(sym)}`);
    return r.ok ? (await r.json()).bars : [];
  }

  async function fetchNewsPage(): Promise<NewsItem[]> {
    return (await (await fetch("/api/news?limit=100")).json()).news;
  }

  function select(sym: string) {
    const q = quotes.value[sym];
    if (!q) return;
    tab.value = q.market;
    if (selected.value !== sym) { selected.value = sym; void loadResearch(); }
    chartJump.value++;
  }

  function snipe(sym: string, mode: "spot" | "fut", side: "buy" | "sell", lev?: number) {
    select(sym);
    orderPreset.value = { mode, side, lev, seq: Date.now() };
  }

  return { quotes, sectors, date, news, tick, connected, direction, lastBars, barsEpoch, ranking, players, mmRanking, whaleRanking, markReacted, settled, chat, banner, whisperAlert, unreadWhispers, replyWhisperTo, season, seasonEpoch, tab, selected, newsDialog, floatingNewsOpen, toggleFloatingNews, guideOpen, spyTarget, orderPreset, socialTab, bookPick, bookEpoch, chartJump, research, calendarOpen, loadResearch, badges, loadBadges, isChamp, list, current,
    loadSnapshot, loadRanking, connect, fetchBars, fetchNewsPage, select, snipe };
});
