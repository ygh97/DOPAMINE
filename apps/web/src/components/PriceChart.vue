<script setup lang="ts">
// KLineChart 차트. 서버에서 1분봉을 받아 그리고, SSE tick마다 마지막 봉을 갱신한다.
// 보유 평단·선물 진입가·청산가·익절·스탑로스 기준선을 차트에 함께 표시한다.
import { dispose, init, type Chart, type KLineData } from "klinecharts";
import { onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { alpha, mount, register, type DrawingController } from "../chart/drawing-tools.js";
import { money } from "../format";
import { useAccount } from "../stores/account";
import { useMarket, type PackedBar } from "../stores/market";
import { useUi } from "../stores/ui";

const m = useMarket();
const a = useAccount();
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
let posIds: string[] = [];
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

/** 현재 종목의 현물 평단·선물 진입가·청산가·익절·스탑로스 수평선을 갱신한다 */
function syncPosLines() {
  if (!chart) return;
  for (const id of posIds) chart.removeOverlay(id);
  posIds = [];
  if (!base.length || !a.me || !shown) return;
  const ts = base[base.length - 1].timestamp;
  const add = (value: number, label: string, color: string, dashed = false) => {
    const id = chart!.createOverlay({ name: "posLine", groupId: "positions", lock: true, points: [{ timestamp: ts, value }], extendData: { label, color, dashed } });
    if (typeof id === "string") posIds.push(id);
  };
  const spot = a.me.positions.find(p => p.sym === shown);
  if (spot) add(spot.avg, `현물 평단 ${money(spot.avg)}`, cssVar("--accent"));
  for (const f of a.me.futures.filter(x => x.sym === shown)) {
    const dir = f.side === "long" ? "롱" : "숏";
    add(f.entry, `${dir} ${f.lev}x 진입 ${money(f.entry)}`, cssVar(f.side === "long" ? "--up" : "--down"));
    add(f.liq, `청산가 ${money(f.liq)}`, cssVar("--warn"), true);
    if (f.tp != null) add(f.tp, `익절 ${money(f.tp)}`, "#16a34a", true);
    if (f.stop != null) add(f.stop, `스탑로스 ${money(f.stop)}`, cssVar("--muted"), true);
  }
}

function redraw() {
  if (!chart) return;
  const price = base[base.length - 1]?.close ?? 1;
  chart.setPriceVolumePrecision(price < 1 ? 4 : 2, 0);
  chart.resize();
  chart.applyNewData(aggregate(base, period.value));
  chart.scrollToRealTime();
  syncPosLines();
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

async function loadRemoteDrawings() {
  if (!drawings || !a.token) return;
  const remote = await a.fetchDrawings();
  if (remote) drawings.mergeRemote(remote);
}

// tick: 같은 시각의 봉이면 교체, 새 시각이면 이어 붙임 (사용자가 보고 있는 스크롤 위치 유지)
watch(() => m.lastBars, bars => {
  const p = bars[shown];
  if (!chart || !p || !base.length) return;
  const b = toBar(p), last = base[base.length - 1];
  if (b.timestamp === last.timestamp) base[base.length - 1] = b;
  else if (b.timestamp > last.timestamp) { base.push(b); if (base.length > 1500) base.shift(); }
  else return;
  if (period.value === 1) { chart.updateData(b); return; }
  const span = period.value * 60_000, t0 = Math.floor(b.timestamp / span) * span;
  let i = base.length - 1;
  while (i > 0 && base[i - 1].timestamp >= t0) i--;
  chart.updateData(aggregate(base.slice(i), period.value)[0]);
});
watch(() => m.selected, sym => void show(sym));
watch(() => m.barsEpoch[m.selected], () => void show(m.selected)); // 주식병합 등으로 과거 봉이 바뀜
watch(() => m.seasonEpoch, () => { drawings?.clearAll(); shown = ""; void show(m.selected); }); // 새 시즌
watch(period, redraw);
watch(() => a.me, syncPosLines);
watch(() => a.token, tok => { if (tok) void loadRemoteDrawings(); });
watch(() => ui.theme, () => { chart?.setStyles(chartStyles()); syncPosLines(); }, { flush: "post" });

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

onMounted(async () => {
  register();
  chart = init(chartEl.value!, { styles: chartStyles(), timezone: "Asia/Seoul" });
  if (!chart) return;
  chart.setBarSpace(10);
  chart.setOffsetRightDistance(50);
  chart.createIndicator({ name: "MA", calcParams: [5, 20, 60] }, true, { id: "candle_pane" });
  subPanes.VOL = chart.createIndicator("VOL", false, { height: 80 }) ?? "";
  drawings = mount(chart, barEl.value!, popEl.value!, p => a.syncDrawing(p));
  new ResizeObserver(() => chart?.resize()).observe(chartEl.value!);
  addEventListener("pagehide", saveOnLeave);
  await show(m.selected);
  if (a.token) await loadRemoteDrawings();
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
