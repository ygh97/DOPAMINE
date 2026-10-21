// 시세·뉴스 상태. 접속 시 /api/snapshot 한 번, 이후 /api/stream(SSE)으로 변경분만 받는다.
// Cloudflare Quick Tunnel(*.trycloudflare.com)처럼 무한 SSE 스트림을 버퍼링하는 프록시에서는 자동으로 /api/poll(1초 폴링)로 전환한다.
import type { GameDate, MarketKind, NewsItem, Quote } from "@dopamine/engine";
import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";

export interface RankRow { rank: number; name: string; equity: number; returnPct: number; clearedTick: number | null }
export interface ChatMsg { id: number; name: string; text: string; at: number; to?: string | null }
export interface OrderPreset { mode: "spot" | "fut"; side: "buy" | "sell"; lev?: number; seq: number }
/** 서버가 보내는 압축 봉: [timestamp, open, high, low, close, volume] */
export type PackedBar = [number, number, number, number, number, number];
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
  /** 진행 중 시즌. 시즌이 바뀌면 seasonEpoch가 올라가고 차트·계좌가 새로 받는다 */
  const season = ref<{ id: number; startedAt: number; endsAt: number } | null>(null);
  const seasonEpoch = ref(0);
  /** 마지막으로 병합·폐지 정산된 종목들. 계좌 스토어가 보고 내 보유와 겹치면 계좌를 다시 받는다 */
  const settled = ref<{ type: string; sym: string }[]>([]);
  const chat = ref<ChatMsg[]>([]);
  const banner = ref<{ id: number; text: string; kind: "clear" | "liq" } | null>(null);
  let lastBannerId = 0;
  function checkBanner(msg: ChatMsg) {
    if (msg.name !== "⚡전광판" || msg.id <= lastBannerId) return;
    lastBannerId = msg.id;
    const kind: "clear" | "liq" = msg.text.startsWith("[100배졸업]") ? "clear" : "liq";
    const text = msg.text.replace(/^\[(100배졸업|강제청산)\]\s*/, "");
    banner.value = { id: msg.id, text, kind };
    setTimeout(() => { if (banner.value?.id === msg.id) banner.value = null; }, 6000);
  }

  const tab = ref<MarketKind>("stock");
  const selected = ref("NVDA");
  const newsDialog = ref<{ mode: "detail"; id: string } | { mode: "list"; sym?: string } | null>(null);
  const guideOpen = ref(false);
  const spyTarget = ref<string | null>(null);
  const orderPreset = ref<OrderPreset | null>(null);
  const socialTab = ref<"chat" | "rank" | "hall">("rank");

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
    if (Array.isArray(s.chat)) { chat.value = s.chat; lastBannerId = s.chat.at(-1)?.id ?? 0; }
    applyQuotes(s.quotes);
    await loadRanking();
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
        if (Array.isArray(d.chat)) { chat.value = d.chat; for (const c of d.chat) checkBanner(c); }
        if (d.ranking) applyRanking(d.ranking);
        if (Array.isArray(d.settled) && d.settled.length) settled.value = d.settled;
      } catch {
        connected.value = false;
      }
    }, 1000);
  }

  function connect() {
    if (typeof location !== "undefined" && location.hostname.endsWith(".trycloudflare.com")) {
      startPolling();
      return;
    }
    source?.close();
    source = new EventSource("/api/stream");
    lastMessageAt = Date.now();
    source.onopen = () => { connected.value = true; void loadSnapshot(); }; // 재연결 시 놓친 상태 회복
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
      if (chat.value.length > 100) chat.value.shift();
    });
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

  function applyRanking(d: { rows: RankRow[]; players: number }) { ranking.value = d.rows; players.value = d.players; }
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
    selected.value = sym;
  }

  function snipe(sym: string, mode: "spot" | "fut", side: "buy" | "sell", lev?: number) {
    select(sym);
    orderPreset.value = { mode, side, lev, seq: Date.now() };
  }

  return { quotes, sectors, date, news, tick, connected, direction, lastBars, barsEpoch, ranking, players, settled, chat, banner, season, seasonEpoch, tab, selected, newsDialog, guideOpen, spyTarget, orderPreset, socialTab, list, current,
    loadSnapshot, loadRanking, connect, fetchBars, fetchNewsPage, select, snipe };
});
