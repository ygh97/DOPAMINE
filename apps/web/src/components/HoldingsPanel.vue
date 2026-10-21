<script setup lang="ts">
import { reactive, ref } from "vue";
import { clock, money, pct } from "../format";
import { useAccount } from "../stores/account";
import { useMarket } from "../stores/market";

const a = useAccount();
const m = useMarket();
const tab = ref<"hold" | "fut" | "fills">("hold");
const stops = reactive<Record<number, string>>({});
const TABS = [
  { id: "hold", label: "보유종목" },
  { id: "fut", label: "선물 포지션" },
  { id: "fills", label: "체결 내역" },
] as const;
const SIDE: Record<string, string> = {
  buy: "매수",
  sell: "매도",
  "long-open": "롱 진입",
  "short-open": "숏 진입",
  "long-close": "롱 종료",
  "short-close": "숏 종료",
  liquidation: "강제 청산",
  stop: "스탑로스",
  delist: "상장폐지 정산",
  "split-cash": "병합 단주 정산",
};
const sideClass = (s: string) =>
  s === "buy" || s === "long-open" ? "up" : s === "sell" || s === "short-open" || s === "liquidation" ? "down" : "muted";
const qtyText = (sym: string, q: number) => (m.quotes[sym]?.market === "coin" || !Number.isInteger(q) ? +q.toFixed(6) : q.toLocaleString());

async function applyStop(id: number) {
  const raw = (stops[id] ?? "").trim();
  if (!raw) return;
  const price = Number(raw);
  await a.setStop(id, price);
  stops[id] = "";
}
async function clearStop(id: number) {
  await a.setStop(id, null);
  stops[id] = "";
}
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
    <div v-else-if="tab === 'fut'" class="table-scroll">
      <table v-if="a.futures.length" id="futures" class="grid">
        <thead><tr><th>종목</th><th>방향</th><th>수량</th><th>진입가</th><th>현재가</th><th>청산가</th><th>증거금</th><th>손익</th><th>스탑로스</th><th>종료</th></tr></thead>
        <tbody>
          <tr v-for="f in a.futures" :key="f.id" :data-sym="f.sym" :data-id="f.id" class="clickable" @click="m.select(f.sym)">
            <td><b>{{ f.sym }}</b> <small class="muted">{{ f.name }}</small></td>
            <td :class="f.side === 'long' ? 'up' : 'down'"><b>{{ f.side === "long" ? "롱" : "숏" }} {{ f.lev }}x</b></td>
            <td>{{ qtyText(f.sym, f.qty) }}</td>
            <td>{{ money(f.entry) }}</td>
            <td>{{ money(f.price) }}</td>
            <td class="liq-cell">{{ money(f.liq) }}</td>
            <td>{{ money(f.margin) }}</td>
            <td :class="f.pnl >= 0 ? 'up' : 'down'">{{ f.pnl >= 0 ? "+" : "-" }}{{ money(Math.abs(f.pnl)) }} <small>({{ pct(f.pnlPct) }})</small></td>
            <td class="stop-cell" @click.stop>
              <input v-model="stops[f.id]" class="stop-input" inputmode="decimal" :placeholder="f.stop != null ? money(f.stop) : '미설정'" aria-label="스탑로스 가격" @keydown.enter="applyStop(f.id)">
              <button class="mini-btn" data-act="stop-set" @click="applyStop(f.id)">설정</button>
              <button v-if="f.stop != null" class="mini-btn" data-act="stop-clear" @click="clearStop(f.id)">해제</button>
            </td>
            <td class="act-cell" @click.stop>
              <button class="mini-btn" data-act="close-10" :disabled="a.busy" @click="a.closeFuture(f.id, 10)">10%</button>
              <button class="mini-btn" data-act="close-20" :disabled="a.busy" @click="a.closeFuture(f.id, 20)">20%</button>
              <button class="mini-btn" data-act="close-50" :disabled="a.busy" @click="a.closeFuture(f.id, 50)">50%</button>
              <button class="mini-btn danger" data-act="close-100" :disabled="a.busy" @click="a.closeFuture(f.id, 100)">종료</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">열려 있는 선물 포지션이 없습니다. 오른쪽 주문 패널의 선물 탭에서 진입해 보세요.</p>
    </div>
    <div v-else class="table-scroll">
      <table v-if="a.me.fills.length" id="fills" class="grid">
        <thead><tr><th>시각</th><th>종목</th><th>구분</th><th>수량</th><th>체결가</th><th>수수료</th></tr></thead>
        <tbody>
          <tr v-for="f in a.me.fills" :key="f.id">
            <td>{{ clock(f.at) }}</td>
            <td><b>{{ f.sym }}</b></td>
            <td :class="sideClass(f.side)">{{ SIDE[f.side] ?? f.side }}</td>
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
