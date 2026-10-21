<script setup lang="ts">
import { computed } from "vue";
import { big, change, money, pct } from "../format";
import { useMarket } from "../stores/market";

const m = useMarket();
const q = computed(() => m.current);
const diff = computed(() => (q.value ? change(q.value.price, q.value.prev) : 0));
</script>

<template>
  <div class="panel">
    <div v-if="q" class="quote-head">
      <h1 id="qSym">{{ q.sym }}<small>{{ q.name }} · 가상 · {{ m.sectors[q.sector] }}{{ q.stage ? ` · ${q.stage}` : "" }}</small></h1>
      <div class="big-price" :class="diff >= 0 ? 'up' : 'down'">{{ money(q.price) }}</div>
      <b :class="diff >= 0 ? 'up' : 'down'">{{ diff >= 0 ? "▲" : "▼" }} {{ money(Math.abs(q.price - q.prev)) }} ({{ pct(diff) }})</b>
      <div class="stats">
        <div class="kv"><span>전일 종가</span><b>{{ money(q.prev) }}</b></div>
        <div class="kv"><span>액면가</span><b>{{ q.parValue ? `$${q.parValue.toFixed(2)}` : "-" }}</b></div>
        <div class="kv"><span>시총</span><b>{{ big(q.cap) }}</b></div>
        <div class="kv"><span>PER</span><b>{{ q.per ? `${q.per.toFixed(1)}배` : "-" }}</b></div>
      </div>
    </div>
    <div v-else class="quote-head muted">시세를 불러오는 중</div>
  </div>
</template>
