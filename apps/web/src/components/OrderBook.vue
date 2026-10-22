<script setup lang="ts">
// 호가창: 보고 있는 종목의 매도·매수 10단계(모바일은 5단계)와 최근 체결. 1초마다 /api/book을 받는다.
// 호가 대부분은 시스템 호가 봇이 깐다. 가격을 누르면 주문 패널이 그 가격의 지정가로 바뀐다.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useAccount } from "../stores/account";
import { useMarket } from "../stores/market";

type Lv = [number, number];
interface BookData { sym: string; tick: number; tickSize: number; asks: Lv[]; bids: Lv[]; trades: [number, number, number, number][] }

const DEPTH = 10;
const m = useMarket();
const a = useAccount();
const book = ref<BookData | null>(null);
const view = ref<"book" | "trades">("book");

async function load() {
  const sym = m.selected;
  if (!sym || document.visibilityState !== "visible") return;
  try {
    const r = await fetch(`/api/book?sym=${encodeURIComponent(sym)}`);
    if (r.ok && m.selected === sym) book.value = await r.json();
  } catch { /* 다음 1초에 다시 */ }
}
let timer = 0;
onMounted(() => { void load(); timer = window.setInterval(load, 1000); });
onUnmounted(() => clearInterval(timer));
watch(() => m.selected, () => { book.value = null; void load(); });
watch(() => m.bookEpoch, () => void load());

const pad = (rows: Lv[]) => [...rows.slice(0, DEPTH), ...Array.from({ length: Math.max(0, DEPTH - rows.length) }, () => null)];
// 매도는 먼 가격이 위, 가까운 가격이 아래 (가운데 현재가 쪽으로 모인다)
const asks = computed(() => pad(book.value?.asks ?? []).reverse());
const bids = computed(() => pad(book.value?.bids ?? []));
const maxQty = computed(() => Math.max(1e-9, ...[...(book.value?.asks ?? []), ...(book.value?.bids ?? [])].map(l => l[1])));
const bar = (q: number) => `${Math.min(100, (q / maxQty.value) * 100)}%`;

const decimals = computed(() => {
  const t = book.value?.tickSize ?? 0.01;
  return Math.min(8, Math.max(0, -Math.floor(Math.log10(t) + 1e-9)));
});
const px = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: decimals.value, maximumFractionDigits: decimals.value });
const qty = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e4 ? `${(v / 1e3).toFixed(1)}K` : v >= 100 ? Math.round(v).toLocaleString() : +v.toFixed(v >= 1 ? 2 : 4) + "");

const spread = computed(() => {
  const ask = book.value?.asks[0]?.[0], bid = book.value?.bids[0]?.[0];
  return ask != null && bid != null ? ((ask - bid) / ((ask + bid) / 2)) * 100 : null;
});
const last = computed(() => m.current?.price ?? 0);
const lastClass = computed(() => (m.current ? (m.current.price >= m.current.prev ? "up" : "down") : ""));

// 내 지정가가 걸린 가격 (호가 단위 반 칸 안이면 같은 가격)
const mine = computed(() => (a.me?.orders ?? []).filter(o => o.sym === m.selected));
const isMine = (p: number, side: "buy" | "sell") => mine.value.some(o => o.side === side && Math.abs(o.price - p) < (book.value?.tickSize ?? 0) / 2);

function pick(p: number) { m.bookPick = { price: p, seq: Date.now() }; }
</script>

<template>
  <div class="panel book-panel" aria-label="호가창">
    <div class="panel-head">
      <div class="tabs" role="tablist">
        <button role="tab" data-b="book" :aria-selected="view === 'book'" @click="view = 'book'">호가</button>
        <button role="tab" data-b="trades" :aria-selected="view === 'trades'" @click="view = 'trades'">체결</button>
      </div>
      <span v-if="spread != null" class="muted book-spread" title="최우선 매도·매수 호가 차이">{{ spread.toFixed(3) }}%</span>
    </div>
    <div v-if="view === 'book'" id="orderBook" class="book">
      <div class="book-side book-asks">
        <button v-for="(l, i) in asks" :key="'a' + i" type="button" class="lvl ask" :disabled="!l" :data-price="l?.[0]" @click="l && pick(l[0])">
          <i class="lvl-bar" :style="{ width: l ? bar(l[1]) : '0' }" />
          <span class="lvl-px">{{ l ? px(l[0]) : "" }}<b v-if="l && isMine(l[0], 'sell')" class="mine-dot" title="내 지정가">●</b></span>
          <span class="lvl-qty">{{ l ? qty(l[1]) : "" }}</span>
        </button>
      </div>
      <div class="book-mid" :class="lastClass">
        <b>{{ last ? px(last) : "-" }}</b>
        <small class="muted">호가 단위 {{ book ? px(book.tickSize) : "-" }}</small>
      </div>
      <div class="book-side book-bids">
        <button v-for="(l, i) in bids" :key="'b' + i" type="button" class="lvl bid" :disabled="!l" :data-price="l?.[0]" @click="l && pick(l[0])">
          <i class="lvl-bar" :style="{ width: l ? bar(l[1]) : '0' }" />
          <span class="lvl-px">{{ l ? px(l[0]) : "" }}<b v-if="l && isMine(l[0], 'buy')" class="mine-dot" title="내 지정가">●</b></span>
          <span class="lvl-qty">{{ l ? qty(l[1]) : "" }}</span>
        </button>
      </div>
      <p class="book-note muted">호가 대부분은 시스템 호가 봇이 깝니다 · 가격을 누르면 지정가</p>
    </div>
    <ul v-else id="recentTrades" class="trades">
      <li class="trades-head muted"><span>가격</span><span>수량</span><span>시각</span></li>
      <li v-for="(t, i) in book?.trades ?? []" :key="i" :class="t[2] > 0 ? 'up' : 'down'">
        <span>{{ px(t[0]) }}</span><span>{{ qty(t[1]) }}</span><span class="muted">{{ Math.max(0, m.tick - t[3]) }}초 전</span>
      </li>
      <li v-if="!book?.trades.length" class="empty">아직 체결이 없습니다.</li>
    </ul>
  </div>
</template>
