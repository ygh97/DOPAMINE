<script setup lang="ts">
import { computed, reactive } from "vue";
import { clock, money, pct } from "../format";
import { useAccount, type Fill } from "../stores/account";
import { useMarket } from "../stores/market";

const a = useAccount();
const m = useMarket();
const stops = reactive<Record<number, string>>({});
const tps = reactive<Record<number, string>>({});

const SIDE: Record<string, string> = {
  buy: "매수",
  sell: "매도",
  "long-open": "롱 진입",
  "short-open": "숏 진입",
  "long-close": "롱 종료",
  "short-close": "숏 종료",
  liquidation: "강제 청산",
  stop: "스탑로스",
  tp: "익절",
  delist: "상장폐지 정산",
  "split-cash": "병합 단주 정산",
};
const isSpotSide = (s: string) => s === "buy" || s === "sell" || s === "split-cash";
const fillMarketLabel = (s: string) => (isSpotSide(s) ? "현물" : s === "delist" ? "정산" : "선물");
const fillMarketClass = (s: string) => (isSpotSide(s) ? "mkt-spot" : s === "delist" ? "mkt-etc" : "mkt-fut");
const sideClass = (s: string) =>
  s === "buy" || s === "long-open" || s === "tp" ? "up" : s === "sell" || s === "short-open" || s === "liquidation" ? "down" : "muted";
const qtyText = (sym: string, q: number) => (m.quotes[sym]?.market === "coin" || !Number.isInteger(q) ? +q.toFixed(6) : q.toLocaleString());
const signedMoney = (v: number) => `${v >= 0 ? "+" : "-"}${money(Math.abs(v))}`;

// 내 거래 실시간 요약 데이터
const spotStats = computed(() => {
  const value = a.positions.reduce((s, p) => s + p.value, 0);
  const pnl = a.positions.reduce((s, p) => s + p.pnl, 0);
  return { value, pnl };
});
const futStats = computed(() => {
  const value = a.futures.reduce((s, f) => s + f.value, 0);
  const pnl = a.futures.reduce((s, f) => s + f.pnl, 0);
  return { value, pnl };
});
const fillStats = computed(() => {
  const fills = a.me?.fills ?? [];
  const closed = fills.filter(f => f.pnl != null);
  const realized = closed.reduce((s, f) => s + (f.pnl ?? 0), 0);
  const wins = closed.filter(f => (f.pnl ?? 0) > 0).length;
  const winRate = closed.length ? Math.round((wins / closed.length) * 100) : 0;
  return { total: fills.length, closed: closed.length, wins, winRate, realized };
});

async function applyStop(id: number) {
  const raw = (stops[id] ?? "").trim();
  if (!raw) return;
  await a.setStop(id, Number(raw));
  stops[id] = "";
}
async function clearStop(id: number) {
  await a.setStop(id, null);
  stops[id] = "";
}
async function applyTp(id: number) {
  const raw = (tps[id] ?? "").trim();
  if (!raw) return;
  await a.setTp(id, Number(raw));
  tps[id] = "";
}
async function clearTp(id: number) {
  await a.setTp(id, null);
  tps[id] = "";
}
// "자랑" 공유: 문구는 서버가 실제 계좌 값으로 만든다 (화면에서 숫자를 꾸밀 수 없게)
async function shareSpot(p: { sym: string }) {
  m.socialTab = "chat";
  await a.share({ type: "spot", sym: p.sym });
}
async function shareFut(f: { id: number }) {
  m.socialTab = "chat";
  await a.share({ type: "fut", id: f.id });
}
async function shareFill(f: Fill) {
  m.socialTab = "chat";
  await a.share({ type: "fill", id: f.id });
}
</script>

<template>
  <div class="panel" aria-label="내 포지션 및 거래 데이터">
    <div class="panel-head hold-head">
      <div class="tabs" role="tablist">
        <button role="tab" data-t="hold" :aria-selected="a.holdTab === 'hold'" @click="a.holdTab = 'hold'">
          보유종목 <span v-if="a.me" class="tab-cnt">{{ a.positions.length }}</span>
        </button>
        <button role="tab" data-t="fut" :aria-selected="a.holdTab === 'fut'" @click="a.holdTab = 'fut'">
          선물 포지션 <span v-if="a.me" class="tab-cnt">{{ a.futures.length }}</span>
        </button>
        <button role="tab" data-t="fills" :aria-selected="a.holdTab === 'fills'" @click="a.holdTab = 'fills'">
          체결 내역 <span v-if="a.me" class="tab-cnt">{{ a.me.fills.length }}</span>
        </button>
      </div>
      <div v-if="a.me" class="bulk-actions">
        <button id="sellAllSpotBtn" class="mini-btn danger" :disabled="a.busy || !a.positions.length" @click="a.closeAll('spot')">
          현물 일괄매도 ({{ a.positions.length }})
        </button>
        <button id="closeAllFutBtn" class="mini-btn danger" :disabled="a.busy || !a.futures.length" @click="a.closeAll('futures')">
          선물 일괄종료 ({{ a.futures.length }})
        </button>
        <button v-if="a.positions.length && a.futures.length" id="closeAllBtn" class="mini-btn danger-fill" :disabled="a.busy" @click="a.closeAll('all')">
          전량 일괄청산
        </button>
      </div>
    </div>

    <div v-if="a.me" id="myTradeStats" class="my-stats">
      <div>
        <span class="muted">현물 평가</span>
        <b>{{ money(spotStats.value) }}</b>
        <small :class="spotStats.pnl >= 0 ? 'up' : 'down'">({{ signedMoney(spotStats.pnl) }})</small>
      </div>
      <div>
        <span class="muted">선물 평가</span>
        <b>{{ money(futStats.value) }}</b>
        <small :class="futStats.pnl >= 0 ? 'up' : 'down'">({{ signedMoney(futStats.pnl) }})</small>
      </div>
      <div>
        <span class="muted">실현손익(최근)</span>
        <b :class="fillStats.realized >= 0 ? 'up' : 'down'">{{ signedMoney(fillStats.realized) }}</b>
      </div>
      <div>
        <span class="muted">승률·체결</span>
        <b>{{ fillStats.closed ? `${fillStats.winRate}% (${fillStats.wins}/${fillStats.closed})` : "—" }}</b>
        <small class="muted">총 {{ fillStats.total }}건</small>
      </div>
    </div>

    <p v-if="!a.me" class="empty">참가하면 보유종목·선물 포지션·체결 내역과 거래 통계가 여기에 표시됩니다.</p>
    <div v-else-if="a.holdTab === 'hold'" class="table-scroll">
      <table v-if="a.positions.length" id="holdings" class="grid">
        <thead><tr><th>종목</th><th>수량</th><th>평단</th><th>현재가</th><th>평가금액</th><th>평가손익</th><th>수익률</th><th>즉시 매도·공유</th></tr></thead>
        <tbody>
          <tr v-for="p in a.positions" :key="p.sym" :data-sym="p.sym" class="clickable" @click="m.select(p.sym)">
            <td><b>{{ p.sym }}</b> <small class="muted">{{ p.name }}</small></td>
            <td>{{ qtyText(p.sym, p.qty) }}</td>
            <td>{{ money(p.avg) }}</td>
            <td>{{ money(p.price) }}</td>
            <td>{{ money(p.value) }}</td>
            <td :class="p.pnl >= 0 ? 'up' : 'down'">{{ signedMoney(p.pnl) }}</td>
            <td :class="p.pnl >= 0 ? 'up' : 'down'">{{ pct(p.pnlPct) }}</td>
            <td class="act-cell" @click.stop>
              <button class="mini-btn" data-act="sell-10" :disabled="a.busy" @click="a.order(p.sym, 'sell', 10)">10%</button>
              <button class="mini-btn" data-act="sell-20" :disabled="a.busy" @click="a.order(p.sym, 'sell', 20)">20%</button>
              <button class="mini-btn" data-act="sell-50" :disabled="a.busy" @click="a.order(p.sym, 'sell', 50)">50%</button>
              <button class="mini-btn danger" data-act="sell-100" :disabled="a.busy" @click="a.order(p.sym, 'sell', 100)">전량매도</button>
              <button class="mini-btn" data-act="share-spot" @click="shareSpot(p)">자랑</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">
        보유 현물 종목이 없습니다.
        <button v-if="a.futures.length" class="link-btn" @click="a.holdTab = 'fut'">열려 있는 선물 포지션 {{ a.futures.length }}건 보기 →</button>
      </p>
    </div>
    <div v-else-if="a.holdTab === 'fut'" class="table-scroll">
      <table v-if="a.futures.length" id="futures" class="grid">
        <thead><tr><th>종목</th><th>방향</th><th>수량</th><th>진입가</th><th>현재가</th><th>청산가</th><th>증거금</th><th>손익</th><th>익절(TP)</th><th>손절(SL)</th><th>즉시 종료·공유</th></tr></thead>
        <tbody>
          <tr v-for="f in a.futures" :key="f.id" :data-sym="f.sym" :data-id="f.id" class="clickable" @click="m.select(f.sym)">
            <td><b>{{ f.sym }}</b> <small class="muted">{{ f.name }}</small></td>
            <td :class="f.side === 'long' ? 'up' : 'down'"><b>{{ f.side === "long" ? "롱" : "숏" }} {{ f.lev }}x</b></td>
            <td>{{ qtyText(f.sym, f.qty) }}</td>
            <td>{{ money(f.entry) }}</td>
            <td>{{ money(f.price) }}</td>
            <td class="liq-cell">{{ money(f.liq) }}</td>
            <td>{{ money(f.margin) }}</td>
            <td :class="f.pnl >= 0 ? 'up' : 'down'">{{ signedMoney(f.pnl) }} <small>({{ pct(f.pnlPct) }})</small></td>
            <td class="stop-cell" @click.stop>
              <input v-model="tps[f.id]" class="stop-input" inputmode="decimal" :placeholder="f.tp != null ? money(f.tp) : '익절가'" aria-label="익절 가격" @keydown.enter="applyTp(f.id)">
              <button class="mini-btn" data-act="tp-set" @click="applyTp(f.id)">설정</button>
              <button v-if="f.tp != null" class="mini-btn" data-act="tp-clear" @click="clearTp(f.id)">해제</button>
            </td>
            <td class="stop-cell" @click.stop>
              <input v-model="stops[f.id]" class="stop-input" inputmode="decimal" :placeholder="f.stop != null ? money(f.stop) : '손절가'" aria-label="스탑로스 가격" @keydown.enter="applyStop(f.id)">
              <button class="mini-btn" data-act="stop-set" @click="applyStop(f.id)">설정</button>
              <button v-if="f.stop != null" class="mini-btn" data-act="stop-clear" @click="clearStop(f.id)">해제</button>
            </td>
            <td class="act-cell" @click.stop>
              <button class="mini-btn" data-act="close-10" :disabled="a.busy" @click="a.closeFuture(f.id, 10)">10%</button>
              <button class="mini-btn" data-act="close-20" :disabled="a.busy" @click="a.closeFuture(f.id, 20)">20%</button>
              <button class="mini-btn" data-act="close-50" :disabled="a.busy" @click="a.closeFuture(f.id, 50)">50%</button>
              <button class="mini-btn danger" data-act="close-100" :disabled="a.busy" @click="a.closeFuture(f.id, 100)">종료</button>
              <button class="mini-btn" data-act="share-fut" @click="shareFut(f)">자랑</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">
        열려 있는 선물 포지션이 없습니다.
        <button v-if="a.positions.length" class="link-btn" @click="a.holdTab = 'hold'">보유 현물 종목 {{ a.positions.length }}건 보기 →</button>
      </p>
    </div>
    <div v-else class="table-scroll">
      <table v-if="a.me.fills.length" id="fills" class="grid">
        <thead><tr><th>시각</th><th>종목</th><th>유형</th><th>구분</th><th>수량</th><th>체결가</th><th>수수료</th><th>실현손익</th><th>공유</th></tr></thead>
        <tbody>
          <tr v-for="f in a.me.fills" :key="f.id" class="clickable" @click="m.select(f.sym)">
            <td>{{ clock(f.at) }}</td>
            <td><b>{{ f.sym }}</b></td>
            <td><span class="fill-mkt-badge" :class="fillMarketClass(f.side)">{{ fillMarketLabel(f.side) }}</span></td>
            <td :class="sideClass(f.side)"><b>{{ SIDE[f.side] ?? f.side }}</b></td>
            <td>{{ qtyText(f.sym, f.qty) }}</td>
            <td>{{ money(f.price) }}</td>
            <td>{{ money(f.fee) }}</td>
            <td :class="f.pnl == null ? 'muted' : f.pnl >= 0 ? 'up' : 'down'">{{ f.pnl == null ? "—" : signedMoney(f.pnl) }}</td>
            <td class="act-cell" @click.stop>
              <button class="mini-btn" data-act="share-fill" @click="shareFill(f)">자랑</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">아직 체결 내역이 없습니다.</p>
    </div>
  </div>
</template>
