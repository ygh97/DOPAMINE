<script setup lang="ts">
// 주문 패널: 현물 매수·매도, 선물 롱·숏 진입 (격리 증거금, 종목별 레버리지).
import { LEVERAGE } from "@dopamine/engine";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { money } from "../format";
import { useAccount } from "../stores/account";
import { useMarket } from "../stores/market";

const FEE = 0.0005, SLIP = 0.0005;
const m = useMarket();
const a = useAccount();
const mode = ref<"spot" | "fut">("spot");
const side = ref<"buy" | "sell">("buy");
const pct = ref(20);
const custom = ref("");
const lev = ref(2);

const levels = computed(() => LEVERAGE[m.current?.market ?? "stock"]);
const lockRemainSec = computed(() => (a.me?.resetAt != null ? Math.max(0, 600 - (m.tick - a.me.resetAt)) : 0));
watch(levels, l => { if (!l.includes(lev.value)) lev.value = l[0]; });
const cash = computed(() => a.me?.cash ?? 100_000);
const held = computed(() => (m.current ? a.holding(m.current.sym) : 0));
const fractional = computed(() => m.current?.market === "coin");
const unit = computed(() => (m.current?.market === "coin" ? ` ${m.current.sym}` : "주"));
const fmtQty = (q: number) => (fractional.value ? q.toFixed(6) : mode.value === "fut" ? (+q.toFixed(2)).toLocaleString() : Math.floor(q).toLocaleString());

function setCustom() {
  const v = Number(custom.value);
  if (v > 0 && v <= 100) pct.value = v;
}

// 체결 전 어림값: 실제 체결가는 다음 tick의 기준가 ± 슬리피지 (주문 충격 포함)
const est = computed(() => {
  const q = m.current;
  if (!q) return null;
  if (mode.value === "spot" && side.value === "sell") {
    const qty = (held.value * pct.value) / 100, value = qty * q.price * (1 - SLIP);
    return { qty: fmtQty(qty), fee: money(value * FEE), total: money(value * (1 - FEE)), liq: "" };
  }
  const budget = (cash.value * pct.value) / 100;
  const notional = mode.value === "fut" ? (budget / (1 + lev.value * FEE)) * lev.value : budget / (1 + FEE + SLIP);
  return {
    qty: fmtQty(notional / q.price),
    fee: money(notional * (FEE + SLIP)),
    total: money(budget),
    liq: money(side.value === "buy" ? q.price * (1 - 0.9 / lev.value) : q.price * (1 + 0.9 / lev.value)),
  };
});
const sideLabel = (s: "buy" | "sell") => (mode.value === "fut" ? (s === "buy" ? "롱" : "숏") : s === "buy" ? "매수" : "매도");
const canOrder = computed(() => !!a.me && !a.busy && (mode.value === "fut" ? cash.value >= 1 : side.value === "buy" || held.value > 0));
const ctaText = computed(() => {
  const sym = m.current?.sym ?? "";
  if (!a.me) return `${sym} ${sideLabel(side.value)} · 참가 후 가능`;
  if (mode.value === "fut") return `${sym} ${lev.value}x ${pct.value}% ${sideLabel(side.value)}`;
  if (side.value === "sell" && !held.value) return `${sym} 보유 없음`;
  return `${sym} ${pct.value}% ${sideLabel(side.value)}`;
});
function submit() {
  if (!canOrder.value || !m.current) return;
  if (mode.value === "fut") void a.openFuture(m.current.sym, side.value === "buy" ? "long" : "short", lev.value, pct.value);
  else void a.order(m.current.sym, side.value, pct.value);
}

const PCT_KEYS: Record<string, number> = { "1": 10, "2": 20, "3": 50, "4": 100 };
function onKey(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement | null)?.isContentEditable) return;
  if (document.querySelector("dialog[open]")) return;
  const k = e.key.toLowerCase();
  if (k === "b") { side.value = "buy"; e.preventDefault(); }
  else if (k === "s") { side.value = "sell"; e.preventDefault(); }
  else if (PCT_KEYS[k]) { pct.value = PCT_KEYS[k]; custom.value = ""; e.preventDefault(); }
}
onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="panel" aria-label="주문">
    <div class="panel-head">
      <div class="tabs" role="tablist">
        <button role="tab" data-o="spot" :aria-selected="mode === 'spot'" @click="mode = 'spot'">현물</button>
        <button role="tab" data-o="fut" :aria-selected="mode === 'fut'" @click="mode = 'fut'">선물</button>
      </div>
      <span class="muted" style="margin-left: auto">{{ m.current?.sym }}</span>
    </div>
    <div v-if="est" class="order-body">
      <div class="seg">
        <button class="buy" data-s="buy" :aria-pressed="side === 'buy'" @click="side = 'buy'">{{ sideLabel("buy") }}</button>
        <button class="sell" data-s="sell" :aria-pressed="side === 'sell'" @click="side = 'sell'">{{ sideLabel("sell") }}</button>
      </div>
      <div v-if="mode === 'fut'">
        <div class="field-label">
          <span>레버리지 (최대 {{ levels[levels.length - 1] }}배)</span>
          <span v-if="lockRemainSec > 0" class="liq-cell">고배율 잠금 {{ Math.floor(lockRemainSec / 60) }}:{{ String(lockRemainSec % 60).padStart(2, '0') }}</span>
          <span v-else>격리 증거금</span>
        </div>
        <div class="chips" :style="{ gridTemplateColumns: `repeat(${levels.length}, 1fr)` }">
          <button v-for="l in levels" :key="l" :data-lev="l" :aria-pressed="lev === l" @click="lev = l">{{ l }}x</button>
        </div>
      </div>
      <div>
        <div class="field-label">
          <span>{{ mode === "fut" ? "증거금 비중" : side === "buy" ? "예수금 비중" : "보유 비중" }}</span>
          <span>{{ mode === "spot" && side === "sell" ? `${fmtQty(held)}${unit}` : money(cash) }}</span>
        </div>
        <div class="chips pct-chips">
          <button v-for="p in [10, 20, 50, 100]" :key="p" :aria-pressed="pct === p" @click="pct = p; custom = ''">{{ p }}%</button>
          <input v-model="custom" class="pct-input" inputmode="decimal" placeholder="직접 %" aria-label="비중 직접 입력" @input="setCustom">
        </div>
      </div>
      <div class="summary">
        <div><span class="muted">예상 수량</span><b>{{ est.qty }}{{ unit }}</b></div>
        <div><span class="muted">수수료·슬리피지</span><span>{{ est.fee }}</span></div>
        <div><span class="muted">{{ side === "sell" && mode === "spot" ? "받을 금액" : "총액" }}</span><b>{{ est.total }}</b></div>
        <div v-if="mode === 'fut'"><span class="muted">예상 청산가</span><b id="estLiq">{{ est.liq }}</b></div>
      </div>
      <button id="orderBtn" class="cta" :class="{ sell: side === 'sell' }" :disabled="!canOrder" @click="submit">{{ ctaText }}</button>
      <p class="order-note muted">체결은 다음 1초 tick에 묶어서 됩니다 · 단축키: B(매수/롱) S(매도/숏) 1~4(10~100%)</p>
    </div>
  </div>
</template>
