<script setup lang="ts">
import type { MarketKind, Quote } from "@dopamine/engine";
import { change, money, pct } from "../format";
import { useMarket } from "../stores/market";

const m = useMarket();
const TABS: { id: MarketKind; label: string }[] = [
  { id: "stock", label: "주식" },
  { id: "coin", label: "코인" },
  { id: "venture", label: "신흥주" },
];
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
    <div class="watch-scroll">
      <table class="watch-table">
        <thead><tr><th>종목</th><th>현재가</th><th>주간등락</th></tr></thead>
        <tbody id="watchBody">
          <tr v-for="q in m.list" :key="q.sym" :data-sym="q.sym" :aria-selected="q.sym === m.selected" @click="m.select(q.sym)">
            <td class="sym">
              <b>{{ q.sym }}<span v-if="q.stage" class="stage" :class="{ danger: q.stage === '관리종목' }">{{ q.stage }}</span></b>
              <small>{{ q.name }} · {{ m.sectors[q.sector] }}</small>
            </td>
            <!-- tick마다 셀을 새로 만들어 깜빡임 애니메이션을 다시 실행 -->
            <td :key="m.tick" :class="[tone(q), flash(q)]">{{ money(q.price) }}</td>
            <td :class="tone(q)">{{ pct(change(q.price, q.prev)) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
