<script setup lang="ts">
import type { NewsItem } from "@dopamine/engine";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { badgeClass, badgeText, change, clock, pct } from "../format";
import { useMarket } from "../stores/market";

const m = useMarket();

const rect = reactive({
  x: 310,
  y: 118,
  w: 440,
  h: 420,
});
const minimized = ref(false);
const filter = ref<"all" | "sym" | "corp">("all");
const expandedId = ref<string | null>(null);
const paused = ref(false);
const listEl = ref<HTMLElement | null>(null);

onMounted(() => {
  try {
    const raw = localStorage.getItem("dc-float-news-rect");
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p.x === "number") rect.x = Math.max(8, Math.min(window.innerWidth - 260, p.x));
      if (typeof p.y === "number") rect.y = Math.max(8, Math.min(window.innerHeight - 120, p.y));
      if (typeof p.w === "number") rect.w = Math.max(300, Math.min(window.innerWidth - 24, p.w));
      if (typeof p.h === "number") rect.h = Math.max(220, Math.min(window.innerHeight - 40, p.h));
    }
  } catch { /* ignore */ }
});

function saveRect() {
  try {
    localStorage.setItem("dc-float-news-rect", JSON.stringify(rect));
  } catch { /* ignore */ }
}

const filteredNews = computed(() => {
  const list = m.news.slice(0, 80);
  if (filter.value === "sym") return list.filter(n => n.symbols.includes(m.selected));
  if (filter.value === "corp") return list.filter(n => n.kind === "기업" || n.kind === "코인" || n.kind === "신흥주");
  return list;
});

function symMove(n: NewsItem, sym: string): number | null {
  const p0 = n.priceAt[sym];
  const q = m.quotes[sym];
  if (!p0 || !q) return null;
  return change(q.price, p0);
}

function onListScroll() {
  const el = listEl.value;
  if (!el) return;
  paused.value = el.scrollTop > 24;
}

function scrollToTop() {
  if (listEl.value) listEl.value.scrollTop = 0;
  paused.value = false;
}

// 드래그 이동 및 모서리 크기 조절
let mode: "drag" | "resize" | null = null;
let startX = 0, startY = 0, origX = 0, origY = 0, origW = 0, origH = 0;

function onPointerMove(e: PointerEvent) {
  if (!mode) return;
  const dx = e.clientX - startX;
  const dy = e.clientY - startY;
  if (mode === "drag") {
    rect.x = Math.max(4, Math.min(window.innerWidth - 180, origX + dx));
    rect.y = Math.max(4, Math.min(window.innerHeight - 60, origY + dy));
  } else if (mode === "resize") {
    rect.w = Math.max(300, Math.min(window.innerWidth - rect.x - 8, origW + dx));
    rect.h = Math.max(200, Math.min(window.innerHeight - rect.y - 8, origH + dy));
  }
}

function onPointerUp() {
  if (!mode) return;
  mode = null;
  saveRect();
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
}

function startDrag(e: PointerEvent) {
  if ((e.target as HTMLElement).closest("button")) return;
  mode = "drag";
  startX = e.clientX; startY = e.clientY;
  origX = rect.x; origY = rect.y;
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
}

function startResize(e: PointerEvent) {
  e.stopPropagation();
  e.preventDefault();
  mode = "resize";
  startX = e.clientX; startY = e.clientY;
  origW = rect.w; origH = rect.h;
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
}

onBeforeUnmount(() => {
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
});
</script>

<template>
  <aside
    v-if="m.floatingNewsOpen"
    id="floatingNewsWin"
    class="float-news-win"
    :class="{ 'is-min': minimized }"
    :style="{
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.w}px`,
      height: minimized ? 'auto' : `${rect.h}px`,
    }"
    aria-label="실시간 뉴스 플로팅 창"
  >
    <header class="float-news-head" @pointerdown="startDrag">
      <div class="float-news-title">
        <span class="live">LIVE</span>
        <b>실시간 속보 모니터</b>
        <small class="muted">({{ filteredNews.length }})</small>
      </div>
      <div class="float-news-actions">
        <button type="button" class="float-win-btn" :title="minimized ? '펼치기' : '접기'" @click="minimized = !minimized">
          {{ minimized ? "▢" : "—" }}
        </button>
        <button type="button" class="float-win-btn close" title="뉴스 플로팅 창 닫기" @click="m.toggleFloatingNews(false)">✕</button>
      </div>
    </header>

    <template v-if="!minimized">
      <div class="float-news-toolbar">
        <div class="float-filter-tabs">
          <button type="button" :aria-pressed="filter === 'all'" @click="filter = 'all'">전체</button>
          <button type="button" :aria-pressed="filter === 'corp'" @click="filter = 'corp'">기업·코인만</button>
          <button type="button" :aria-pressed="filter === 'sym'" @click="filter = 'sym'">현재 종목(${{ m.selected }})</button>
        </div>
        <button v-if="paused" type="button" class="float-top-btn" @click="scrollToTop">⬆ 최신으로</button>
      </div>

      <div ref="listEl" class="float-news-list" @scroll.passive="onListScroll">
        <div
          v-for="(n, idx) in filteredNews"
          :key="n.id"
          class="float-news-card"
          :class="{ 'is-latest': idx === 0, 'is-expanded': expandedId === n.id }"
          @click="expandedId = expandedId === n.id ? null : n.id"
        >
          <div class="float-card-top">
            <span :class="badgeClass(n)">{{ badgeText(n) }}</span>
            <span v-if="n.symbols.length" class="float-card-syms" @click.stop>
              <button v-for="s in n.symbols" :key="s" type="button" class="sym-tag" @click="m.select(s)">
                ${{ s }}
                <small v-if="symMove(n, s) != null" :class="symMove(n, s)! >= 0 ? 'up' : 'down'">
                  {{ pct(symMove(n, s)!) }}
                </small>
              </button>
            </span>
            <time class="muted float-card-time">{{ clock(n.at) }}</time>
          </div>
          <div class="float-card-headline">{{ n.headline }}</div>
          <p v-if="expandedId === n.id || idx === 0" class="float-card-body">
            {{ n.body }}
            <button type="button" class="link-btn float-detail-link" @click.stop="m.newsDialog = { mode: 'detail', id: n.id }">상세창 열기 ↗</button>
          </p>
        </div>
        <p v-if="!filteredNews.length" class="empty">조건에 맞는 뉴스가 없습니다.</p>
      </div>

      <div class="float-resize-grip" title="드래그하여 크기 조절" @pointerdown="startResize">◢</div>
    </template>
  </aside>
</template>
