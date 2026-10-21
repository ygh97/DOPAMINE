<script setup lang="ts">
import { ref } from "vue";
import { clock, money, pct } from "../format";
import { useAccount } from "../stores/account";
import { useMarket } from "../stores/market";

const a = useAccount();
const m = useMarket();
const tab = ref<"hold" | "fut" | "fills">("hold");
const TABS = [
  { id: "hold", label: "보유종목" },
  { id: "fut", label: "선물 포지션" },
  { id: "fills", label: "체결 내역" },
] as const;
const SIDE: Record<string, string> = { buy: "매수", sell: "매도", delist: "상장폐지 정산", "split-cash": "병합 단주 정산" };
const qtyText = (sym: string, q: number) => (m.quotes[sym]?.market === "coin" || !Number.isInteger(q) ? +q.toFixed(6) : q.toLocaleString());
</script>

<template>
  <div class="panel">
    <div class="panel-head">
      <div class="tabs" role="tablist">
        <button v-for="t in TABS" :key="t.id" role="tab" :data-t="t.id" :aria-selected="tab === t.id" @click="tab = t.id">{{ t.label }}</button>
      </div>
    </div>
    <p v-if="!a.me" class="empty">참가하면 {{ TABS.find(t => t.id === tab)!.label }}이(가) 여기에 표시됩니다.</p>
    <div v-else-if="tab === 'hold'" class="table-scroll">
      <table v-if="a.positions.length" id="holdings" class="grid">
        <thead><tr><th>종목</th><th>수량</th><th>평단</th><th>현재가</th><th>평가금액</th><th>평가손익</th><th>수익률</th></tr></thead>
        <tbody>
          <tr v-for="p in a.positions" :key="p.sym" :data-sym="p.sym" class="clickable" @click="m.select(p.sym)">
            <td><b>{{ p.sym }}</b> <small class="muted">{{ p.name }}</small></td>
            <td>{{ qtyText(p.sym, p.qty) }}</td>
            <td>{{ money(p.avg) }}</td>
            <td>{{ money(p.price) }}</td>
            <td>{{ money(p.value) }}</td>
            <td :class="p.pnl >= 0 ? 'up' : 'down'">{{ p.pnl >= 0 ? "+" : "-" }}{{ money(Math.abs(p.pnl)) }}</td>
            <td :class="p.pnl >= 0 ? 'up' : 'down'">{{ pct(p.pnlPct) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">보유종목이 없습니다. 오른쪽 주문 패널에서 매수해 보세요.</p>
    </div>
    <p v-else-if="tab === 'fut'" class="empty">선물은 준비 중입니다 (M4).</p>
    <div v-else class="table-scroll">
      <table v-if="a.me.fills.length" id="fills" class="grid">
        <thead><tr><th>시각</th><th>종목</th><th>구분</th><th>수량</th><th>체결가</th><th>수수료</th></tr></thead>
        <tbody>
          <tr v-for="f in a.me.fills" :key="f.id">
            <td>{{ clock(f.at) }}</td>
            <td><b>{{ f.sym }}</b></td>
            <td :class="f.side === 'buy' ? 'up' : f.side === 'sell' ? 'down' : 'muted'">{{ SIDE[f.side] ?? f.side }}</td>
            <td>{{ qtyText(f.sym, f.qty) }}</td>
            <td>{{ money(f.price) }}</td>
            <td>{{ money(f.fee) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">아직 체결 내역이 없습니다.</p>
    </div>
  </div>
</template>
