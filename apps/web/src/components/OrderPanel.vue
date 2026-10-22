<script setup lang="ts">
// 주문 패널: 현물 매수·매도, 선물 롱·숏 진입 (격리 증거금, 종목별 레버리지). 시장가 / 지정가.
// 시장가는 호가를 먹으며 바로 체결(수수료 0.05%). 지정가는 맞는 호가만큼 바로 체결하고 나머지를 걸어 둔다(체결 때 수수료 0).
import { LEVERAGE, tickSize } from "@dopamine/engine";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { money } from "../format";
import { useAccount } from "../stores/account";
import { useMarket } from "../stores/market";

const FEE = 0.0005;
const m = useMarket();
const a = useAccount();
const mode = ref<"spot" | "fut">("spot");
const type = ref<"market" | "limit">("market");
const side = ref<"buy" | "sell">("buy");
const pct = ref(20);
const custom = ref("");
const lev = ref(2);
const limitText = ref("");

const levels = computed(() => LEVERAGE[m.current?.market ?? "stock"]);
const lockRemainSec = computed(() => (a.me?.resetAt != null ? Math.max(0, 600 - (m.tick - a.me.resetAt)) : 0));
watch(levels, l => { if (!l.includes(lev.value)) lev.value = l[0]; });
watch(() => m.orderPreset, p => {
  if (!p) return;
  mode.value = p.mode;
  side.value = p.side;
  if (p.lev && levels.value.includes(p.lev)) lev.value = p.lev;
});
const cash = computed(() => a.me?.cash ?? 100_000);
const held = computed(() => (m.current ? a.holding(m.current.sym) : 0));
const fractional = computed(() => m.current?.market === "coin");
const unit = computed(() => (m.current?.market === "coin" ? ` ${m.current.sym}` : "주"));
const fmtQty = (q: number) => (fractional.value ? q.toFixed(6) : Math.floor(q + 1e-9).toLocaleString()); // 주식·신흥주는 현물·선물 모두 1주 단위

// 지정가: 호가 단위(가격의 약 0.02%)로 맞춘다. 서버도 같은 단위로 반올림한다
const tick = computed(() => tickSize(m.current?.price ?? 1));
const decimals = computed(() => Math.min(8, Math.max(0, -Math.floor(Math.log10(tick.value) + 1e-9))));
const fmtPx = (v: number) => v.toFixed(decimals.value);
const limitPrice = computed(() => { const v = Number(limitText.value); return v > 0 ? Math.round(v / tick.value) * tick.value : 0; });
function nudge(n: number) { limitText.value = fmtPx(Math.max(tick.value, (limitPrice.value || m.current?.price || 0) + n * tick.value)); }
watch(type, t => { if (t === "limit" && !limitPrice.value && m.current) limitText.value = fmtPx(m.current.price); });
watch(() => m.selected, () => { if (type.value === "limit" && m.current) limitText.value = fmtPx(m.current.price); });
watch(() => m.bookPick, p => { if (p) { type.value = "limit"; limitText.value = fmtPx(p.price); } });

function setCustom() {
  const v = Number(custom.value);
  if (v > 0 && v <= 100) pct.value = v;
}

// 체결 전 어림값. 시장가는 현재가 기준이라 큰 주문은 호가를 여러 단계 먹어 더 불리하게 체결된다
const est = computed(() => {
  const q = m.current;
  if (!q) return null;
  const price = type.value === "limit" ? limitPrice.value : q.price;
  if (!price) return { qty: "-", fee: "-", total: "-", liq: "" };
  const feeRate = type.value === "limit" ? 0 : FEE;
  if (mode.value === "spot" && side.value === "sell") {
    const qty = (held.value * pct.value) / 100, value = qty * price;
    return { qty: fmtQty(qty), fee: money(value * feeRate), total: money(value * (1 - feeRate)), liq: "" };
  }
  const budget = (cash.value * pct.value) / 100;
  const notional = mode.value === "fut" ? (budget / (1 + lev.value * FEE)) * lev.value : budget / (1 + FEE);
  return {
    qty: fmtQty(notional / price),
    fee: money(notional * feeRate),
    total: money(budget),
    liq: money(side.value === "buy" ? price * (1 - 0.9 / lev.value) : price * (1 + 0.9 / lev.value)),
  };
});
const sideLabel = (s: "buy" | "sell") => (mode.value === "fut" ? (s === "buy" ? "롱" : "숏") : s === "buy" ? "매수" : "매도");
const canOrder = computed(() => !!a.me && !a.busy && (type.value === "market" || limitPrice.value > 0)
  && (mode.value === "fut" ? cash.value >= 1 : side.value === "buy" || held.value > 0));
const ctaText = computed(() => {
  const sym = m.current?.sym ?? "";
  const at = type.value === "limit" ? ` $${limitPrice.value ? fmtPx(limitPrice.value) : "-"} 지정가` : "";
  if (!a.me) return `${sym} ${sideLabel(side.value)} · 참가 후 가능`;
  if (mode.value === "fut") return `${sym} ${lev.value}x ${pct.value}%${at} ${sideLabel(side.value)}`;
  if (side.value === "sell" && !held.value) return `${sym} 보유 없음`;
  return `${sym} ${pct.value}%${at} ${sideLabel(side.value)}`;
});
function submit() {
  if (!canOrder.value || !m.current) return;
  const sym = m.current.sym;
  if (type.value === "limit") void a.limit({ sym, kind: mode.value, side: side.value, price: limitPrice.value, pct: pct.value, lev: mode.value === "fut" ? lev.value : undefined });
  else if (mode.value === "fut") void a.openFuture(sym, side.value === "buy" ? "long" : "short", lev.value, pct.value);
  else void a.order(sym, side.value, pct.value);
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
      <div class="tabs" role="tablist" style="margin-left: auto">
        <button role="tab" data-ot="market" :aria-selected="type === 'market'" @click="type = 'market'">시장가</button>
        <button role="tab" data-ot="limit" :aria-selected="type === 'limit'" @click="type = 'limit'">지정가</button>
      </div>
    </div>
    <div v-if="est" class="order-body">
      <div class="seg">
        <button class="buy" data-s="buy" :aria-pressed="side === 'buy'" @click="side = 'buy'">{{ sideLabel("buy") }}</button>
        <button class="sell" data-s="sell" :aria-pressed="side === 'sell'" @click="side = 'sell'">{{ sideLabel("sell") }}</button>
      </div>
      <div v-if="type === 'limit'">
        <div class="field-label"><span>지정 가격 ($)</span><span>호가 단위 {{ fmtPx(tick) }}</span></div>
        <div class="limit-row">
          <button type="button" class="mini-btn" aria-label="한 호가 내리기" @click="nudge(-1)">−</button>
          <input id="limitPrice" v-model="limitText" class="limit-input" inputmode="decimal" aria-label="지정 가격">
          <button type="button" class="mini-btn" aria-label="한 호가 올리기" @click="nudge(1)">+</button>
        </div>
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
        <div><span class="muted">수수료</span><span>{{ est.fee }}</span></div>
        <div><span class="muted">{{ side === "sell" && mode === "spot" ? "받을 금액" : type === "limit" ? "묶이는 금액" : "총액" }}</span><b>{{ est.total }}</b></div>
        <div v-if="mode === 'fut'"><span class="muted">예상 청산가</span><b id="estLiq">{{ est.liq }}</b></div>
      </div>
      <button id="orderBtn" class="cta" :class="{ sell: side === 'sell' }" :disabled="!canOrder" @click="submit">{{ ctaText }}</button>
      <p v-if="type === 'market'" class="order-note muted">시장가는 호가를 먹으며 바로 체결 · 수수료 0.05% · 큰 주문은 여러 호가를 먹어 더 밀립니다 · 단축키: B(매수/롱) S(매도/숏) 1~4(10~100%)</p>
      <p v-else class="order-note muted">맞는 호가가 있으면 그만큼 바로 체결(수수료 0.05%), 나머지는 걸어 둡니다(체결 때 수수료 0). 걸어 둔 동안 돈·수량이 묶이고, 취소하면 풀립니다 · 최대 20개, 시즌 끝까지</p>
    </div>
  </div>
</template>
