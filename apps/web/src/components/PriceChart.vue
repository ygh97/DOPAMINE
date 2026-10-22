<script setup lang="ts">
// KLineChart 트레이딩뷰 스타일 차트.
// - 1분/3분/5분/15분/30분/1시간/4시간 타임프레임
// - 전체화면(⛶), 전체봉 한눈에 보기(↔ 전체봉), 최신봉 이동(▶ 최신봉), 줌(+/-)
// - 사용자 직접 차트 설정(⚙️): 캔들 모양(캔들/속빈캔들/바/영역), 상단 수치 표시 방식(모바일 가림 방지), MA 기간 직접 입력, 최고·최저가/현재가선/포지션선/격자선/Y축 안쪽 배치 설정
import { dispose, init, type Chart, type KLineData } from "klinecharts";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { alpha, mount, register, type DrawingController } from "../chart/drawing-tools.js";
import { change, money, pct } from "../format";
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
  { n: 3, label: "3분" },
  { n: 5, label: "5분" },
  { n: 15, label: "15분" },
  { n: 30, label: "30분" },
  { n: 60, label: "1시간" },
  { n: 240, label: "4시간" },
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
const isFullscreen = ref(false);
const settingsOpen = ref(false);

const isMobileInit = typeof window !== "undefined" && window.innerWidth <= 760;

export interface ChartUserConfig {
  candleType: "candle_solid" | "candle_stroke" | "candle_up_stroke" | "ohlc" | "area";
  tooltipRule: "always" | "follow_cross" | "none";
  barSpace: number;
  showHighLow: boolean;
  showLastPrice: boolean;
  showPosLines: boolean;
  showGrid: boolean;
  yAxisInside: boolean;
  ma1On: boolean; ma1: number;
  ma2On: boolean; ma2: number;
  ma3On: boolean; ma3: number;
  ma4On: boolean; ma4: number;
}

const cfg = reactive<ChartUserConfig>({
  candleType: "candle_solid",
  // 모바일에서는 숫자가 차트 캔들을 가리지 않도록 기본값을 'follow_cross'(터치·십자선 시 표시)로 설정
  tooltipRule: isMobileInit ? "follow_cross" : "follow_cross",
  barSpace: isMobileInit ? 8 : 10,
  showHighLow: !isMobileInit,
  showLastPrice: true,
  showPosLines: true,
  showGrid: true,
  yAxisInside: isMobileInit,
  ma1On: true, ma1: 5,
  ma2On: true, ma2: 20,
  ma3On: true, ma3: 60,
  ma4On: false, ma4: 120,
});

try {
  const saved = localStorage.getItem("dc-chart-settings-v1");
  if (saved) Object.assign(cfg, JSON.parse(saved));
} catch { /* ignore */ }

function saveCfg() {
  try {
    localStorage.setItem("dc-chart-settings-v1", JSON.stringify(cfg));
  } catch { /* ignore */ }
}

const activeMaParams = computed(() => {
  const out: number[] = [];
  if (cfg.ma1On && cfg.ma1 >= 2) out.push(Math.round(cfg.ma1));
  if (cfg.ma2On && cfg.ma2 >= 2) out.push(Math.round(cfg.ma2));
  if (cfg.ma3On && cfg.ma3 >= 2) out.push(Math.round(cfg.ma3));
  if (cfg.ma4On && cfg.ma4 >= 2) out.push(Math.round(cfg.ma4));
  return out.length ? out : [5, 20];
});

let chart: Chart | null = null;
let drawings: DrawingController | null = null;
let base: KLineData[] = [];
let shown = "";
let shownFactor = 1; // 지금 그려진 그림의 기준 병합 배수
let posIds: string[] = [];
const subPanes: Record<string, string> = {};

const latestBar = ref<KLineData | null>(null);

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
  const axisFontSize = isMobileInit ? 10 : 11;
  const axis = {
    axisLine: { color: line },
    tickLine: { color: line },
    tickText: { color: muted, size: axisFontSize },
  };
  const crossText = { backgroundColor: accent, borderColor: accent, size: axisFontSize };
  return {
    grid: {
      show: cfg.showGrid,
      horizontal: { show: cfg.showGrid, color: line, style: "dashed", dashedValue: [3, 3] },
      vertical: { show: cfg.showGrid, color: line, style: "dashed", dashedValue: [3, 3] },
    },
    candle: {
      type: cfg.candleType,
      area: {
        lineSize: 2,
        lineColor: accent,
        value: "close",
        backgroundColor: [
          { offset: 0, color: alpha(accent, 0.02) },
          { offset: 1, color: alpha(accent, 0.28) },
        ],
      },
      bar: { upColor: up, downColor: down, noChangeColor: muted, upBorderColor: up, downBorderColor: down, noChangeBorderColor: muted, upWickColor: up, downWickColor: down, noChangeWickColor: muted },
      priceMark: {
        show: true,
        high: { show: cfg.showHighLow, color: text, textSize: axisFontSize },
        low: { show: cfg.showHighLow, color: text, textSize: axisFontSize },
        last: {
          show: cfg.showLastPrice,
          upColor: up,
          downColor: down,
          noChangeColor: muted,
          line: { show: cfg.showLastPrice, style: "dashed", dashedValue: [4, 4], size: 1 },
          text: { show: cfg.showLastPrice, size: axisFontSize, paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2 },
        },
      },
      tooltip: {
        showRule: cfg.tooltipRule,
        showType: "standard",
        text: { color: text, size: isMobileInit ? 10 : 11, marginLeft: 6, marginTop: 4, marginRight: 6, marginBottom: 2 },
      },
    },
    indicator: {
      ohlc: { upColor: up, downColor: down, noChangeColor: muted },
      bars: [{ style: "fill", borderStyle: "solid", borderSize: 1, borderDashedValue: [2, 2], upColor: up + "99", downColor: down + "99", noChangeColor: muted }],
      tooltip: {
        showRule: cfg.tooltipRule,
        showName: true,
        showParams: true,
        text: { color: text, size: isMobileInit ? 10 : 11, marginLeft: 6, marginTop: 2, marginRight: 6, marginBottom: 2 },
      },
    },
    overlay: {
      point: { color: accent, borderColor: alpha(accent, 0.3), activeColor: accent, activeBorderColor: alpha(accent, 0.3) },
      line: { color: accent },
      rect: { color: alpha(accent, 0.12), borderColor: accent },
      polygon: { color: alpha(accent, 0.12), borderColor: accent },
      circle: { color: alpha(accent, 0.12), borderColor: accent },
      text: { color: "#fff", backgroundColor: accent, borderColor: accent },
    },
    xAxis: axis,
    yAxis: {
      ...axis,
      inside: cfg.yAxisInside,
    },
    separator: { color: line },
    crosshair: { horizontal: { line: { color: muted }, text: crossText }, vertical: { line: { color: muted }, text: crossText } },
  } as Parameters<Chart["setStyles"]>[0];
}

function applyUserConfig() {
  saveCfg();
  if (!chart) return;
  chart.setStyles(chartStyles());
  chart.setBarSpace(cfg.barSpace);
  if (on.MA) {
    chart.overrideIndicator({ name: "MA", calcParams: activeMaParams.value }, "candle_pane");
  }
  syncPosLines();
}

/** 현재 종목의 현물 평단·선물 진입가·청산가·익절·스탑로스 수평선을 갱신한다 */
function syncPosLines() {
  if (!chart) return;
  for (const id of posIds) chart.removeOverlay(id);
  posIds = [];
  if (!cfg.showPosLines || !base.length || !a.me || !shown) return;
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
  const agg = aggregate(base, period.value);
  latestBar.value = agg[agg.length - 1] ?? null;
  chart.setBarSpace(cfg.barSpace);
  chart.applyNewData(agg);
  chart.scrollToRealTime();
  syncPosLines();
}

/** 전체봉 한눈에 보기 (전체 히스토리를 화면 폭에 맞춰 축소 표시) */
function fitAllBars() {
  if (!chart || !chartEl.value) return;
  const agg = aggregate(base, period.value);
  if (!agg.length) return;
  const w = Math.max(200, chartEl.value.clientWidth - 70);
  const space = Math.max(1.5, Math.min(20, w / Math.max(20, agg.length)));
  chart.setOffsetRightDistance(16);
  chart.setBarSpace(space);
  chart.scrollToRealTime();
}

/** 기본 배율 및 최신 봉 위치로 복귀 */
function resetToLatest() {
  if (!chart) return;
  chart.setOffsetRightDistance(isMobileInit ? 28 : 50);
  chart.setBarSpace(cfg.barSpace);
  chart.scrollToRealTime();
}

function zoomBy(delta: number) {
  cfg.barSpace = Math.max(2, Math.min(28, cfg.barSpace + delta));
  saveCfg();
  chart?.setBarSpace(cfg.barSpace);
}

function toggleFullscreen() {
  isFullscreen.value = !isFullscreen.value;
  setTimeout(() => chart?.resize(), 30);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && isFullscreen.value) {
    isFullscreen.value = false;
    setTimeout(() => chart?.resize(), 30);
  }
}

async function show(sym: string) {
  if (!chart || !drawings) return;
  if (shown) drawings.save(shown, shownFactor);
  shown = sym;
  const packed = await m.fetchBars(sym);
  if (sym !== shown) return;
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
  if (period.value === 1) {
    latestBar.value = b;
    chart.updateData(b);
    return;
  }
  const span = period.value * 60_000, t0 = Math.floor(b.timestamp / span) * span;
  let i = base.length - 1;
  while (i > 0 && base[i - 1].timestamp >= t0) i--;
  const aggBar = aggregate(base.slice(i), period.value)[0];
  latestBar.value = aggBar;
  chart.updateData(aggBar);
});
watch(() => m.selected, sym => void show(sym));
watch(() => m.barsEpoch[m.selected], () => void show(m.selected));
watch(() => m.seasonEpoch, () => { drawings?.clearAll(); shown = ""; void show(m.selected); });
watch(period, redraw);
watch(() => a.me, syncPosLines);
watch(() => a.token, tok => { if (tok) void loadRemoteDrawings(); });
watch(() => ui.theme, () => { chart?.setStyles(chartStyles()); syncPosLines(); }, { flush: "post" });

function toggle(name: string, main: boolean) {
  if (!chart) return;
  const next = !on[name];
  on[name] = next;
  if (main) {
    if (next) chart.createIndicator(name === "MA" ? { name, calcParams: activeMaParams.value } : name, true, { id: "candle_pane" });
    else chart.removeIndicator("candle_pane", name);
  } else if (next) subPanes[name] = chart.createIndicator(name, false, { height: isMobileInit ? 64 : 85 }) ?? "";
  else { chart.removeIndicator(subPanes[name], name); delete subPanes[name]; }
}

const saveOnLeave = () => { if (shown) drawings?.save(shown, shownFactor); };

onMounted(async () => {
  register();
  chart = init(chartEl.value!, { styles: chartStyles(), timezone: "Asia/Seoul" });
  if (!chart) return;
  chart.setBarSpace(cfg.barSpace);
  chart.setOffsetRightDistance(isMobileInit ? 28 : 50);
  chart.createIndicator({ name: "MA", calcParams: activeMaParams.value }, true, { id: "candle_pane" });
  subPanes.VOL = chart.createIndicator("VOL", false, { height: isMobileInit ? 64 : 80 }) ?? "";
  drawings = mount(chart, barEl.value!, popEl.value!, p => a.syncDrawing(p));
  new ResizeObserver(() => chart?.resize()).observe(chartEl.value!);
  addEventListener("pagehide", saveOnLeave);
  addEventListener("keydown", onKeydown);
  await show(m.selected);
  if (a.token) await loadRemoteDrawings();
});
onBeforeUnmount(() => {
  saveOnLeave();
  removeEventListener("pagehide", saveOnLeave);
  removeEventListener("keydown", onKeydown);
  if (chartEl.value) dispose(chartEl.value);
});
</script>

<template>
  <div class="panel chart-panel" :class="{ 'is-fullscreen': isFullscreen }">
    <!-- 상단 차트 툴바 (트레이딩뷰 스타일) -->
    <div class="panel-head chart-head">
      <div v-if="isFullscreen && m.current" class="fs-quote-badge">
        <b>{{ m.current.name }} ({{ m.current.sym }})</b>
        <span :class="change(m.current.price, m.current.prev) >= 0 ? 'up' : 'down'">
          {{ money(m.current.price) }} ({{ pct(change(m.current.price, m.current.prev)) }})
        </span>
      </div>

      <div class="tabs period-tabs" role="tablist" aria-label="봉 주기">
        <button v-for="p in PERIODS" :key="p.n" role="tab" :data-p="p.n" :aria-selected="period === p.n" @click="period = p.n">{{ p.label }}</button>
      </div>

      <div class="ind-chips" aria-label="지표 및 차트 제어">
        <button v-for="i in INDICATORS" :key="i.name" :data-i="i.name" :aria-pressed="!!on[i.name]" @click="toggle(i.name, i.main)">{{ i.label }}</button>
        <button class="demo-btn" title="대표 그리기 도구를 차트에 한 번에 그려봅니다" @click="drawings?.demo()">도구 예시</button>
      </div>

      <div class="chart-view-tools">
        <button type="button" class="chart-ctrl-btn" title="축소" @click="zoomBy(-2)">－</button>
        <button type="button" class="chart-ctrl-btn" title="확대" @click="zoomBy(2)">＋</button>
        <button id="chartFitBtn" type="button" class="chart-ctrl-btn" title="전체 기간 봉을 한 화면에 모아 보기" @click="fitAllBars">↔ 전체봉</button>
        <button id="chartLatestBtn" type="button" class="chart-ctrl-btn" title="최신 실시간 봉 위치로 이동" @click="resetToLatest">▶ 최신봉</button>
        <button
          id="chartSettingsBtn"
          type="button"
          class="chart-ctrl-btn"
          :aria-pressed="settingsOpen"
          title="차트 모양·이평선·수치 표시 직접 설정"
          @click="settingsOpen = !settingsOpen"
        >
          ⚙️ 설정
        </button>
        <button
          id="chartFsBtn"
          type="button"
          class="chart-ctrl-btn fs-btn"
          :aria-pressed="isFullscreen"
          title="차트 전체화면 보기 (ESC로 복귀)"
          @click="toggleFullscreen"
        >
          {{ isFullscreen ? "✕ 전체화면 닫기" : "⛶ 전체화면" }}
        </button>
      </div>
    </div>

    <!-- 캔들을 가리지 않는 깔끔한 1줄 OHLCV 요약 바 -->
    <div v-if="latestBar" class="chart-ohlc-bar">
      <span class="ohlc-item">시가 <b :class="latestBar.close >= latestBar.open ? 'up' : 'down'">{{ money(latestBar.open) }}</b></span>
      <span class="ohlc-item">고가 <b class="up">{{ money(latestBar.high) }}</b></span>
      <span class="ohlc-item">저가 <b class="down">{{ money(latestBar.low) }}</b></span>
      <span class="ohlc-item">종가 <b :class="latestBar.close >= latestBar.open ? 'up' : 'down'">{{ money(latestBar.close) }}</b></span>
      <span class="ohlc-item">거래량 <b>{{ (latestBar.volume ?? 0).toLocaleString() }}</b></span>
      <span v-if="on.MA" class="ohlc-item ma-summary">MA({{ activeMaParams.join("·") }})</span>
    </div>

    <!-- 사용자 직접 차트 설정 패널 -->
    <div v-if="settingsOpen" id="chartSettingsPanel" class="chart-settings-pop">
      <div class="cs-head">
        <b>⚙️ 트레이딩 차트 사용자 설정</b>
        <button type="button" class="mini-btn" @click="settingsOpen = false">닫기 ✕</button>
      </div>
      <div class="cs-grid">
        <div class="cs-group">
          <label class="cs-label">캔들·차트 스타일</label>
          <div class="cs-seg">
            <button type="button" :aria-pressed="cfg.candleType === 'candle_solid'" @click="cfg.candleType = 'candle_solid'; applyUserConfig()">캔들(채움)</button>
            <button type="button" :aria-pressed="cfg.candleType === 'candle_stroke'" @click="cfg.candleType = 'candle_stroke'; applyUserConfig()">캔들(속빈)</button>
            <button type="button" :aria-pressed="cfg.candleType === 'ohlc'" @click="cfg.candleType = 'ohlc'; applyUserConfig()">OHLC 바</button>
            <button type="button" :aria-pressed="cfg.candleType === 'area'" @click="cfg.candleType = 'area'; applyUserConfig()">라인·영역</button>
          </div>
        </div>

        <div class="cs-group">
          <label class="cs-label">차트 안쪽 수치 글자 표시 (모바일 화면 가림 방지)</label>
          <div class="cs-seg">
            <button type="button" :aria-pressed="cfg.tooltipRule === 'follow_cross'" @click="cfg.tooltipRule = 'follow_cross'; applyUserConfig()">십자선 올릴 때만</button>
            <button type="button" :aria-pressed="cfg.tooltipRule === 'none'" @click="cfg.tooltipRule = 'none'; applyUserConfig()">숨김 (깔끔)</button>
            <button type="button" :aria-pressed="cfg.tooltipRule === 'always'" @click="cfg.tooltipRule = 'always'; applyUserConfig()">항상 표시</button>
          </div>
        </div>

        <div class="cs-group">
          <label class="cs-label">이동평균선 (MA) 기간 직접 설정</label>
          <div class="cs-ma-row">
            <label class="cs-ma-item">
              <input v-model="cfg.ma1On" type="checkbox" @change="applyUserConfig">
              <span>MA1</span>
              <input v-model.number="cfg.ma1" type="number" min="2" max="500" @change="applyUserConfig">
            </label>
            <label class="cs-ma-item">
              <input v-model="cfg.ma2On" type="checkbox" @change="applyUserConfig">
              <span>MA2</span>
              <input v-model.number="cfg.ma2" type="number" min="2" max="500" @change="applyUserConfig">
            </label>
            <label class="cs-ma-item">
              <input v-model="cfg.ma3On" type="checkbox" @change="applyUserConfig">
              <span>MA3</span>
              <input v-model.number="cfg.ma3" type="number" min="2" max="500" @change="applyUserConfig">
            </label>
            <label class="cs-ma-item">
              <input v-model="cfg.ma4On" type="checkbox" @change="applyUserConfig">
              <span>MA4</span>
              <input v-model.number="cfg.ma4" type="number" min="2" max="500" @change="applyUserConfig">
            </label>
          </div>
        </div>

        <div class="cs-group">
          <label class="cs-label">기본 봉 간격 (확대·축소: {{ cfg.barSpace }}px)</label>
          <input v-model.number="cfg.barSpace" type="range" min="2" max="28" step="1" @input="applyUserConfig">
        </div>

        <div class="cs-group cs-checks">
          <label><input v-model="cfg.showHighLow" type="checkbox" @change="applyUserConfig"> 최고·최저가 라벨 표시</label>
          <label><input v-model="cfg.showLastPrice" type="checkbox" @change="applyUserConfig"> 실시간 현재가 점선</label>
          <label><input v-model="cfg.showPosLines" type="checkbox" @change="applyUserConfig"> 내 포지션 선 (평단·청산·익절·손절)</label>
          <label><input v-model="cfg.showGrid" type="checkbox" @change="applyUserConfig"> 배경 격자선 (Grid)</label>
          <label><input v-model="cfg.yAxisInside" type="checkbox" @change="applyUserConfig"> Y축 가격표 차트 안쪽 배치 (모바일 넓게 보기)</label>
        </div>
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
