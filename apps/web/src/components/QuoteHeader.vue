<script setup lang="ts">
import { computed } from "vue";
import { big, change, money, pct } from "../format";
import { useMarket } from "../stores/market";

const m = useMarket();
const q = computed(() => m.current);
const diff = computed(() => (q.value ? change(q.value.price, q.value.prev) : 0));
// 애널리스트 의견 분포 (최근 한 분기 안, 애널리스트마다 마지막 리포트)
const cons = computed(() => { const c = m.research?.consensus; return c && c.buy + c.hold + c.sell ? c : null; });
/** PER: 적자면 음수 그대로(빨강), 1000배 넘으면 999+ */
const perText = computed(() => {
  const p = q.value?.per;
  if (p == null || !Number.isFinite(p)) return "-";
  return Math.abs(p) >= 1000 ? `${p < 0 ? "-" : ""}999+배` : `${p.toFixed(1)}배`;
});
const themeText = computed(() => (q.value?.themes ?? []).map(k => m.sectors[k] ?? k).join("·"));
const symNewsCount = computed(() => (q.value ? m.news.filter(n => n.symbols.includes(q.value!.sym)).length : 0));
</script>

<template>
  <div class="panel">
    <div v-if="q" class="quote-head">
      <h1 id="qSym">{{ q.sym }}<small>{{ q.name }} · 가상 · {{ m.sectors[q.sector] }}<template v-if="themeText"> ({{ themeText }})</template>{{ q.stage ? ` · ${q.stage}` : "" }}</small></h1>
      <div class="big-price" :class="diff >= 0 ? 'up' : 'down'">{{ money(q.price) }}</div>
      <b :class="diff >= 0 ? 'up' : 'down'">{{ diff >= 0 ? "▲" : "▼" }} {{ money(Math.abs(q.price - q.prev)) }} ({{ pct(diff) }})</b>
      <button id="symNewsBtn" type="button" class="icon-btn sym-news-btn" @click="m.newsDialog = { mode: 'list', sym: q.sym }">
        📰 {{ q.sym }} 뉴스 <span class="tab-cnt">{{ symNewsCount }}</span>
      </button>
      <button v-if="cons" id="consensusBtn" type="button" class="icon-btn consensus-btn" title="애널리스트 의견 · 눌러서 적중률 보기" @click="m.socialTab = 'analyst'">
        🧑‍💼 <b class="up">매수 {{ cons.buy }}</b> · 중립 {{ cons.hold }} · <b class="down">매도 {{ cons.sell }}</b>
        <span v-if="cons.target" class="muted"> · 목표 {{ money(cons.target) }}</span>
      </button>
      <div class="stats">
        <div class="kv"><span>주간 기준가</span><b>{{ money(q.prev) }}</b></div>
        <div class="kv"><span>액면가</span><b>{{ q.parValue ? `$${q.parValue.toFixed(2)}` : "-" }}</b></div>
        <div class="kv"><span>시총</span><b>{{ big(q.cap) }}</b></div>
        <div v-if="q.revenue" class="kv"><span>매출(연)</span><b>{{ big(q.revenue) }}</b></div>
        <div class="kv"><span>PER</span><b id="qPer" :class="{ down: (q.per ?? 0) < 0 }">{{ perText }}<small v-if="(q.per ?? 0) < 0"> 적자</small></b></div>
      </div>
    </div>
    <div v-else class="quote-head muted">시세를 불러오는 중</div>
  </div>
</template>
