<script setup lang="ts">
// KLineChart 차트. 서버에서 1분봉을 받아 그리고, SSE tick마다 마지막 봉을 갱신한다.
import { dispose, init, type Chart, type KLineData } from "klinecharts";
import { onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { alpha, mount, register, type DrawingController } from "../chart/drawing-tools.js";
import { useMarket, type PackedBar } from "../stores/market";
import { useUi } from "../stores/ui";

const m = useMarket();
const ui = useUi();
const chartEl = ref<HTMLDivElement | null>(null);
const barEl = ref<HTMLDivElement | null>(null);
const popEl = ref<HTMLDivElement | null>(null);

const PERIODS = [
  { n: 1, label: "1분" },
  { n: 5, label: "5분" },
  { n: 15, label: "15분" },
  { n: 60, label: "1시간" },
];
const INDICATORS = [
  { name: "MA", label: "MA", main: true },
  { name: "EMA", label: "EMA", main: true },
  { name: "BOLL", label: "BOLL", main: true },
  { name: "VOL", label: "거래량", main: false },
  { name: "MACD", label: "MACD", main: false },
  { name: "RSI", label: "RSI", main: false },
];
const period = ref(1);
const on = reactive<Record<string, boolean>>({ MA: true, VOL: true });

let chart: Chart | null = null;
let drawings: DrawingController | null = null;
let base: KLineData[] = [];
let shown = "";
let shownFactor = 1; // 지금 그려진 그림의 기준 병합 배수
const subPanes: Record<string, string> = {};

const toBar = ([timestamp, open, high, low, close, volume]: PackedBar): KLineData => ({ timestamp, open, high, low, close, volume });
const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function aggregate(bars: KLineData[], n: number): KLineData[] {
  if (n === 1) return bars.map(b => ({ ...b }));
  const out: KLineData[] = [], span = n * 60_000;
  for (const b of bars) {
    const t = Math.floor(b.timestamp / span) * span, last = out[out.length - 1];
    if (last && last.timestamp === t) {
      last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close;
      last.volume = (last.volume ?? 0) + (b.volume ?? 0);
    } else out.push({ ...b, timestamp: t });
  }
  return out;
}

function chartStyles() {
  const up = cssVar("--up"), down = cssVar("--down"), line = cssVar("--line"), muted = cssVar("--muted"), text = cssVar("--text"), accent = cssVar("--accent");
  const axis = { axisLine: { color: line }, tickLine: { color: line }, tickText: { color: muted } };
  const crossText = { backgroundColor: accent, borderColor: accent };
  return {
    grid: { horizontal: { color: line }, vertical: { color: line } },
    candle: {
      bar: { upColor: up, downColor: down, noChangeColor: muted, upBorderColor: up, downBorderColor: down, noChangeBorderColor: muted, upWickColor: up, downWickColor: down, noChangeWickColor: muted },
      priceMark: { high: { color: text }, low: { color: text }, last: { upColor: up, downColor: down, noChangeColor: muted } },
      tooltip: { text: { color: text } },
    },
    indicator: {
      ohlc: { upColor: up, downColor: down, noChangeColor: muted },
      bars: [{ style: "fill", borderStyle: "solid", borderSize: 1, borderDashedValue: [2, 2], upColor: up + "99", downColor: down + "99", noChangeColor: muted }],
      tooltip: { text: { color: text } },
    },
    overlay: {
      point: { color: accent, borderColor: alpha(accent, 0.3), activeColor: accent, activeBorderColor: alpha(accent, 0.3) },
      line: { color: accent },
      rect: { color: alpha(accent, 0.12), borderColor: accent },
      polygon: { color: alpha(accent, 0.12), borderColor: accent },
      circle: { color: alpha(accent, 0.12), borderColor: accent },
      text: { color: "#fff", backgroundColor: accent, borderColor: accent },
    },
    xAxis: axis, yAxis: axis, separator: { color: line },
    crosshair: { horizontal: { line: { color: muted }, text: crossText }, vertical: { line: { color: muted }, text: crossText } },
  } as Parameters<Chart["setStyles"]>[0];
}

function redraw() {
  if (!chart) return;
  const price = base[base.length - 1]?.close ?? 1;
  chart.setPriceVolumePrecision(price < 1 ? 4 : 2, 0);
  chart.applyNewData(aggregate(base, period.value));
}

async function show(sym: string) {
  if (!chart || !drawings) return;
  if (shown) drawings.save(shown, shownFactor);
  shown = sym;
  const packed = await m.fetchBars(sym);
  if (sym !== shown) return; // 응답 사이에 다른 종목을 골랐으면 버린다
  base = packed.map(toBar);
  redraw();
  shownFactor = m.quotes[sym]?.splitFactor ?? 1;
  drawings.load(sym, shownFactor);
}

// tick: 같은 시각의 봉이면 교체, 새 시각이면 이어 붙임
watch(() => m.lastBars, bars => {
  const p = bars[shown];
  if (!chart || !p || !base.length) return;
  const b = toBar(p), last = base[base.length - 1];
  if (b.timestamp === last.timestamp) base[base.length - 1] = b;
  else if (b.timestamp > last.timestamp) { base.push(b); if (base.length > 1500) base.shift(); }
  else return;
  const span = period.value * 60_000, t0 = Math.floor(b.timestamp / span) * span;
  chart.updateData(aggregate(base.filter(x => x.timestamp >= t0), period.value)[0]);
});
watch(() => m.selected, sym => void show(sym));
watch(() => m.barsEpoch[m.selected], () => void show(m.selected)); // 주식병합 등으로 과거 봉이 바뀜
watch(period, redraw);
watch(() => ui.theme, () => chart?.setStyles(chartStyles()), { flush: "post" });

function toggle(name: string, main: boolean) {
  if (!chart) return;
  const next = !on[name];
  on[name] = next;
  if (main) {
    if (next) chart.createIndicator(name === "MA" ? { name, calcParams: [5, 20, 60] } : name, true, { id: "candle_pane" });
    else chart.removeIndicator("candle_pane", name);
  } else if (next) subPanes[name] = chart.createIndicator(name, false, { height: 90 }) ?? "";
  else { chart.removeIndicator(subPanes[name], name); delete subPanes[name]; }
}

const saveOnLeave = () => { if (shown) drawings?.save(shown, shownFactor); };

onMounted(() => {
  register();
  chart = init(chartEl.value!, { styles: chartStyles(), timezone: "Asia/Seoul" });
  if (!chart) return;
  chart.createIndicator({ name: "MA", calcParams: [5, 20, 60] }, true, { id: "candle_pane" });
  subPanes.VOL = chart.createIndicator("VOL", false, { height: 80 }) ?? "";
  drawings = mount(chart, barEl.value!, popEl.value!);
  new ResizeObserver(() => chart?.resize()).observe(chartEl.value!);
  addEventListener("pagehide", saveOnLeave);
  void show(m.selected);
});
onBeforeUnmount(() => {
  saveOnLeave();
  removeEventListener("pagehide", saveOnLeave);
  if (chartEl.value) dispose(chartEl.value);
});
</script>

<template>
  <div class="panel">
    <div class="panel-head chart-head">
      <div class="tabs" role="tablist">
        <button v-for="p in PERIODS" :key="p.n" role="tab" :data-p="p.n" :aria-selected="period === p.n" @click="period = p.n">{{ p.label }}</button>
      </div>
      <div class="ind-chips" aria-label="지표">
        <button v-for="i in INDICATORS" :key="i.name" :data-i="i.name" :aria-pressed="!!on[i.name]" @click="toggle(i.name, i.main)">{{ i.label }}</button>
        <button class="demo-btn" title="대표 그리기 도구를 차트에 한 번에 그려봅니다" @click="drawings?.demo()">도구 예시</button>
      </div>
    </div>
    <div class="chart-body">
      <div ref="barEl" class="draw-bar" aria-label="그리기 도구"></div>
      <div class="chart-area">
        <div id="chart" ref="chartEl" aria-label="캔들 차트. 드래그로 이동, 휠로 확대·축소"></div>
        <div ref="popEl" class="draw-pop" aria-label="선택한 그림 편집"></div>
      </div>
    </div>
  </div>
</template>
