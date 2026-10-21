<script setup lang="ts">
import type { MarketKind, Quote } from "@dopamine/engine";
import { computed, ref } from "vue";
import { change, money, pct } from "../format";
import { useMarket } from "../stores/market";

const m = useMarket();
const TABS: { id: MarketKind; label: string }[] = [
  { id: "stock", label: "주식" },
  { id: "coin", label: "코인" },
  { id: "venture", label: "신흥주" },
];
type SortKey = "default" | "up" | "down" | "cap";
const SORTS: { id: SortKey; label: string }[] = [
  { id: "default", label: "기본" },
  { id: "up", label: "급등순" },
  { id: "down", label: "급락순" },
  { id: "cap", label: "시총순" },
];
const sortBy = ref<SortKey>("default");
const query = ref("");

const rows = computed(() => {
  const kw = query.value.trim().toLowerCase();
  let arr = m.list.filter(q => !kw || q.sym.toLowerCase().includes(kw) || q.name.toLowerCase().includes(kw) || (m.sectors[q.sector] ?? "").toLowerCase().includes(kw));
  if (sortBy.value === "up") {
    arr = [...arr].sort((a, b) => change(b.price, b.prev) - change(a.price, a.prev));
  } else if (sortBy.value === "down") {
    arr = [...arr].sort((a, b) => change(a.price, a.prev) - change(b.price, b.prev));
  } else if (sortBy.value === "cap") {
    arr = [...arr].sort((a, b) => (b.cap ?? 0) - (a.cap ?? 0));
  }
  return arr;
});

function pickTab(id: MarketKind) {
  m.tab = id;
  const first = m.list[0];
  if (first) m.select(first.sym);
}
const tone = (q: Quote) => (change(q.price, q.prev) >= 0 ? "up" : "down");
const flash = (q: Quote) => {
  const d = m.direction[q.sym];
  return d > 0 ? "flash-up" : d < 0 ? "flash-down" : "";
};
</script>

<template>
  <section class="panel" aria-label="종목">
    <div class="panel-head">
      <div class="tabs" role="tablist">
        <button v-for="t in TABS" :key="t.id" role="tab" :data-m="t.id" :aria-selected="m.tab === t.id" @click="pickTab(t.id)">
          {{ t.label }}
        </button>
      </div>
    </div>
    <div class="watch-toolbar">
      <input id="watchSearch" v-model="query" class="watch-search" placeholder="티커·종목·업종 검색" aria-label="종목 검색">
      <div class="watch-sorts" role="group" aria-label="정렬 기준">
        <button v-for="s in SORTS" :key="s.id" type="button" :data-sort="s.id" :aria-pressed="sortBy === s.id" @click="sortBy = s.id">
          {{ s.label }}
        </button>
      </div>
    </div>
    <div class="watch-scroll">
      <table class="watch-table">
        <thead><tr><th>종목</th><th>현재가</th><th>주간등락</th></tr></thead>
        <tbody id="watchBody">
          <tr v-for="q in rows" :key="q.sym" :data-sym="q.sym" :aria-selected="q.sym === m.selected" @click="m.select(q.sym)">
            <td class="sym">
              <b>
                {{ q.sym }}
                <span v-if="q.stage" class="stage" :class="{ danger: q.stage === '관리종목' }">{{ q.stage }}</span>
              </b>
              <small>{{ q.name }} · {{ m.sectors[q.sector] }}</small>
            </td>
            <!-- tick마다 셀을 새로 만들어 깜빡임 애니메이션을 다시 실행 -->
            <td :key="m.tick" :class="[tone(q), flash(q)]">{{ money(q.price) }}</td>
            <td :class="tone(q)">{{ pct(change(q.price, q.prev)) }}</td>
          </tr>
          <tr v-if="!rows.length"><td colspan="3" class="empty">조건에 맞는 종목이 없습니다.</td></tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
