// 도파민 센터 그리기 도구: KLineChart v9 overlay 등록 + TradingView식 툴바 컨트롤러.
import { registerOverlay } from "klinecharts";

const GROUP = "drawings";
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const alpha = (hex, a) => {
  const h = hex.replace("#", ""), n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
};
const pct = (from, to) => (to / from - 1) * 100;
const fmtPct = v => (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
const label = (x, y, text, opts = {}) => ({
  type: "text", ignoreEvent: true,
  attrs: {x, y, text, align: opts.align || "center", baseline: opts.baseline || "bottom"},
  styles: opts.bg ? {color: "#fff", backgroundColor: opts.bg, borderColor: opts.bg} : undefined,
});
const box = (a, b) => ({x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y)});
const base = {needDefaultPointFigure: true, needDefaultXAxisFigure: true, needDefaultYAxisFigure: true};

export function register() {

  registerOverlay({...base, name: "crossLine", totalStep: 2,
    createPointFigures: ({coordinates: [c], bounding}) => c ? [
      {type: "line", attrs: {coordinates: [{x: 0, y: c.y}, {x: bounding.width, y: c.y}]}},
      {type: "line", attrs: {coordinates: [{x: c.x, y: 0}, {x: c.x, y: bounding.height}]}},
    ] : []});

  registerOverlay({...base, name: "rectShape", totalStep: 3,
    createPointFigures: ({coordinates: c}) => c.length > 1 ? [{type: "rect", attrs: box(c[0], c[1]), styles: {style: "stroke_fill"}}] : []});

  registerOverlay({...base, name: "circleShape", totalStep: 3,
    createPointFigures: ({coordinates: c}) => c.length > 1
      ? [{type: "circle", attrs: {x: c[0].x, y: c[0].y, r: Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y)}, styles: {style: "stroke_fill"}}] : []});

  registerOverlay({...base, name: "triangleShape", totalStep: 4,
    createPointFigures: ({coordinates: c}) => c.length === 2 ? [{type: "line", attrs: {coordinates: c}}]
      : c.length > 2 ? [{type: "polygon", attrs: {coordinates: c}, styles: {style: "stroke_fill"}}] : []});

  registerOverlay({...base, name: "arrowShape", totalStep: 3,
    createPointFigures: ({coordinates: c}) => {
      if (c.length < 2) return [];
      const [a, b] = c, ang = Math.atan2(b.y - a.y, b.x - a.x), s = 12;
      const head = [b, {x: b.x - s * Math.cos(ang - .45), y: b.y - s * Math.sin(ang - .45)}, {x: b.x - s * Math.cos(ang + .45), y: b.y - s * Math.sin(ang + .45)}];
      return [{type: "line", attrs: {coordinates: c}}, {type: "polygon", attrs: {coordinates: head}, styles: {style: "fill"}}];
    }});

  registerOverlay({...base, name: "textLabel", totalStep: 2,
    createPointFigures: ({overlay, coordinates: [c]}) => c ? [{type: "text", attrs: {x: c.x, y: c.y, text: overlay.extendData || "텍스트", align: "left", baseline: "middle"}}] : []});

  // 측정: 가격 범위 / 기간 범위 / 기간·가격 범위
  const range = (name, showPrice, showBars) => registerOverlay({...base, name, totalStep: 3,
    createPointFigures: ({overlay, coordinates: c, precision, barSpace}) => {
      if (c.length < 2) return [];
      const [p0, p1] = overlay.points, b = box(c[0], c[1]), up = p1.value >= p0.value;
      const color = up ? css("--up") : css("--down"), midX = b.x + b.width / 2, midY = b.y + b.height / 2;
      const text = [];
      if (showPrice) text.push(`${(p1.value - p0.value).toFixed(precision.price)} (${fmtPct(pct(p0.value, p1.value))})`);
      if (showBars) text.push(`${Math.round(b.width / barSpace.bar)}봉`);
      const figs = [{type: "rect", attrs: b, ignoreEvent: true, styles: {style: "fill", color: alpha(color, .12)}}];
      if (showPrice) figs.push({type: "line", attrs: {coordinates: [{x: midX, y: c[0].y}, {x: midX, y: c[1].y}]}, styles: {color}});
      if (showBars) figs.push({type: "line", attrs: {coordinates: [{x: c[0].x, y: midY}, {x: c[1].x, y: midY}]}, styles: {color}});
      figs.push(label(midX, up ? b.y - 6 : b.y + b.height + 6, text.join(" · "), {baseline: up ? "bottom" : "top", bg: color}));
      return figs;
    }});
  range("priceRange", true, false);
  range("dateRange", false, true);
  range("datePriceRange", true, true);

  // 롱/숏 포지션: 진입 → 목표 → 손절 순서로 클릭
  const position = (name, isLong) => registerOverlay({...base, name, totalStep: 4, needDefaultXAxisFigure: false,
    createPointFigures: ({overlay, coordinates: c, precision}) => {
      if (c.length < 2) return [];
      const pts = overlay.points, entry = pts[0].value, p = precision.price;
      const x = Math.min(c[0].x, c[1].x), w = Math.max(48, Math.abs(c[1].x - c[0].x)), mid = x + w / 2;
      const gain = v => (isLong ? 1 : -1) * pct(entry, v);
      const win = css("--up"), loss = css("--down");
      const zone = (y2, color) => ({type: "rect", ignoreEvent: true, attrs: {x, y: Math.min(c[0].y, y2), width: w, height: Math.abs(y2 - c[0].y)}, styles: {style: "fill", color: alpha(color, .16)}});
      const figs = [zone(c[1].y, win), {type: "line", attrs: {coordinates: [{x, y: c[0].y}, {x: x + w, y: c[0].y}]}}];
      figs.push(label(mid, c[1].y, `목표 ${pts[1].value.toFixed(p)} (${fmtPct(gain(pts[1].value))})`, {baseline: c[1].y < c[0].y ? "bottom" : "top", bg: win}));
      if (c.length > 2) {
        const rr = Math.abs(pts[1].value - entry) / (Math.abs(entry - pts[2].value) || 1e-9);
        figs.unshift(zone(c[2].y, loss));
        figs.push(label(mid, c[2].y, `손절 ${pts[2].value.toFixed(p)} (${fmtPct(gain(pts[2].value))})`, {baseline: c[2].y < c[0].y ? "bottom" : "top", bg: loss}));
        figs.push(label(mid, c[0].y, `${isLong ? "롱" : "숏"} ${entry.toFixed(p)} · 손익비 ${rr.toFixed(2)}`, {baseline: "middle", bg: css("--accent")}));
      }
      return figs;
    }});
  position("longPosition", true);
  position("shortPosition", false);

  // 추세 기반 피보나치 확장: 시작 → 끝 → 되돌림 지점
  const FIB_EXT = [0, .382, .618, 1, 1.272, 1.618, 2.618];
  registerOverlay({...base, name: "fibExtension", totalStep: 4,
    createPointFigures: ({overlay, coordinates: c, bounding, yAxis, precision}) => {
      const figs = c.length > 1 ? [{type: "line", attrs: {coordinates: c}, styles: {style: "dashed"}}] : [];
      if (c.length < 3) return figs;
      const [p0, p1, p2] = overlay.points, move = p1.value - p0.value;
      FIB_EXT.forEach(r => {
        const v = p2.value + move * r, y = yAxis.convertToPixel(v);
        figs.push({type: "line", attrs: {coordinates: [{x: c[2].x, y}, {x: bounding.width, y}]}});
        figs.push(label(c[2].x + 4, y - 2, `${r} (${v.toFixed(precision.price)})`, {align: "left"}));
      });
      return figs;
    }});

  // 패턴: 점을 이어 그리고 라벨 표시
  const wave = (name, labels, fills = []) => registerOverlay({...base, name, totalStep: labels.length + 1,
    createPointFigures: ({coordinates: c}) => {
      const figs = [];
      fills.forEach(([a, b, d]) => c.length > d && figs.push({type: "polygon", ignoreEvent: true, attrs: {coordinates: [c[a], c[b], c[d]]}, styles: {style: "fill"}}));
      if (c.length > 1) figs.push({type: "line", attrs: {coordinates: c}});
      c.forEach((p, i) => figs.push(label(p.x, p.y - 8, labels[i])));
      return figs;
    }});
  wave("elliottWave", ["0", "1", "2", "3", "4", "5"]);
  wave("xabcd", ["X", "A", "B", "C", "D"], [[0, 1, 2], [2, 3, 4]]);
  registerOverlay({
    name: "posLine", totalStep: 2, lock: true,
    needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: true,
    createPointFigures: ({overlay, coordinates: [c], bounding}) => {
      if (!c) return [];
      const d = overlay.extendData || {}, color = d.color || css("--accent");
      return [
        {type: "line", ignoreEvent: true, attrs: {coordinates: [{x: 0, y: c.y}, {x: bounding.width, y: c.y}]}, styles: {style: d.dashed ? "dashed" : "solid", dashedValue: [4, 4], color, size: 1}},
        {type: "text", ignoreEvent: true, attrs: {x: 8, y: c.y - 3, text: d.label || "", align: "left", baseline: "bottom"}, styles: {color: "#fff", backgroundColor: color, borderColor: color}},
      ];
    },
  });
}

// 아이콘: 18x18 stroke path
const I = {
  segment: "M3 15 15 3M3 15h0M15 3h0", rayLine: "M3 14 17 4", straightLine: "M1 16 17 2", horizontalStraightLine: "M1 9h16",
  horizontalRayLine: "M4 9h13M4 9h0", verticalStraightLine: "M9 1v16", crossLine: "M1 9h16M9 1v16", priceLine: "M2 11h10M12 8h5v6h-5z",
  parallelStraightLine: "M2 12 14 3M4 16 16 7", priceChannelLine: "M2 13 16 5M2 8h0M2 16 16 8", fibonacciLine: "M2 3h14M2 7h14M2 11h14M2 15h14",
  fibExtension: "M2 15 7 5l4 6M11 2h6M11 6h6M11 10h6", xabcd: "M2 14 6 4l3 7 4-8 3 10", elliottWave: "M1 15 5 7l2 4 4-9 2 6 4-3",
  longPosition: "M3 3h12v6H3zM3 9v6h12V9", shortPosition: "M3 3h12v6H3zM3 9v6h12V9M9 11v3", priceRange: "M9 2v14M6 5l3-3 3 3M6 13l3 3 3-3",
  dateRange: "M2 9h14M5 6 2 9l3 3M13 6l3 3-3 3", datePriceRange: "M3 3h12v12H3zM9 5v8M5 9h8", rectShape: "M3 4h12v10H3z",
  circleShape: "M9 2.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z", triangleShape: "M9 3 16 15H2z", arrowShape: "M3 15 15 3M9 3h6v6",
  textLabel: "M4 4h10M9 4v11", simpleAnnotation: "M3 3h12v9H8l-3 3v-3H3z", simpleTag: "M2 9 6 4h10v10H6z",
  cursor: "M4 2v13l3.5-3.5 2.5 5 2-1-2.5-5H15z", magnet: "M4 3v6a5 5 0 0 0 10 0V3M4 6h3M11 6h3", keep: "M4 14 14 4M11 3l4 4-9 9H2v-4z",
  lock: "M5 8V6a4 4 0 0 1 8 0v2M4 8h10v8H4z", eye: "M1 9s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5zM9 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  trash: "M3 5h12M7 5V3h4v2M5 5l1 11h6l1-11",
};
const icon = k => `<svg viewBox="0 0 18 18"><path d="${I[k]}"/></svg>`;

const GROUPS = [
  ["선", [["segment", "추세선"], ["rayLine", "레이"], ["straightLine", "연장선"], ["horizontalStraightLine", "수평선"], ["horizontalRayLine", "수평 레이"], ["verticalStraightLine", "수직선"], ["crossLine", "십자선"], ["priceLine", "가격선"]]],
  ["채널·피보나치", [["parallelStraightLine", "평행 채널"], ["priceChannelLine", "가격 채널"], ["fibonacciLine", "피보나치 되돌림"], ["fibExtension", "피보나치 확장 (3점)"]]],
  ["패턴", [["xabcd", "XABCD 패턴 (5점)"], ["elliottWave", "엘리엇 파동 (6점)"]]],
  ["측정·포지션", [["longPosition", "롱 포지션 (진입·목표·손절)"], ["shortPosition", "숏 포지션 (진입·목표·손절)"], ["priceRange", "가격 범위"], ["dateRange", "기간 범위"], ["datePriceRange", "기간·가격 범위"]]],
  ["도형", [["rectShape", "사각형"], ["circleShape", "원"], ["triangleShape", "삼각형"], ["arrowShape", "화살표"]]],
  ["텍스트", [["textLabel", "텍스트"], ["simpleAnnotation", "메모"], ["simpleTag", "태그"]]],
];
const TEXT_TOOLS = new Set(["textLabel", "simpleAnnotation", "simpleTag"]);
const MAGNET = [["normal", "자석 끔"], ["weak_magnet", "약한 자석"], ["strong_magnet", "강한 자석"]];
const SWATCHES = ["#1f5fbf", "#e0353b", "#1d6fd8", "#2f9e44", "#f59f00", "#7950f2", "#868e96"];

const STORAGE_KEY = "dc-drawings-v1";
const readSaved = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch { return {}; } };

export function mount(chart, bar, pop, onSync) {
  let curKey = "", curFactor = 1, clearing = false;
  const ids = new Set(), saved = readSaved(), current = {};
  let drawingId = null, selectedId = null, activeTool = null, keep = false, locked = false, hidden = false, magnet = 0;

  bar.innerHTML = [
    `<button class="tool" data-act="cursor" title="커서 (Esc)">${icon("cursor")}</button><hr>`,
    ...GROUPS.map(([title, tools], gi) => {
      current[gi] = tools[0][0];
      return `<div class="tool-group" data-g="${gi}">
        <button class="tool" data-g="${gi}" title="${tools[0][1]}">${icon(tools[0][0])}</button>
        <button class="more" data-more="${gi}" title="${title} 더 보기" aria-label="${title} 더 보기"></button>
        <div class="flyout" role="menu"><div class="flyout-title">${title}</div>
          ${tools.map(([n, l]) => `<button role="menuitem" data-tool="${n}" data-g="${gi}">${icon(n)}<span>${l}</span></button>`).join("")}
        </div></div>`;
    }),
    `<hr>`,
    `<button class="tool" data-act="magnet" title="자석 끔">${icon("magnet")}</button>`,
    `<button class="tool" data-act="keep" title="그리기 유지 (도구 연속 사용)">${icon("keep")}</button>`,
    `<button class="tool" data-act="lock" title="모든 그림 잠금">${icon("lock")}</button>`,
    `<button class="tool" data-act="hide" title="모든 그림 숨기기">${icon("eye")}</button>`,
    `<button class="tool" data-act="clear" title="모든 그림 지우기">${icon("trash")}</button>`,
  ].join("");
  pop.innerHTML = SWATCHES.map(c => `<button class="sw" data-color="${c}" style="background:${c}" aria-label="색 ${c}"></button>`).join("")
    + `<span class="sep"></span>` + [1, 2, 3].map(s => `<button class="w" data-size="${s}" aria-label="두께 ${s}"><i style="height:${s}px"></i></button>`).join("")
    + `<span class="sep"></span><button class="del" data-del aria-label="선택한 그림 삭제">${icon("trash")}</button>`;

  const q = s => bar.querySelector(s);
  const closeMenus = () => bar.querySelectorAll(".tool-group.open").forEach(g => g.classList.remove("open"));
  const each = fn => ids.forEach(id => chart.getOverlayById(id) && fn(id));
  function setActive(name) {
    activeTool = name;
    bar.querySelectorAll(".tool[data-g]").forEach(b => b.setAttribute("aria-pressed", current[b.dataset.g] === name));
  }
  function callbacks() {
    return {
      onDrawEnd: e => { ids.add(e.overlay.id); drawingId = null; const t = activeTool; setActive(null); persist(); if (keep && t) start(t); return false; },
      onSelected: e => { selectedId = e.overlay.id; pop.hidden = false; return false; },
      onDeselected: () => { selectedId = null; pop.hidden = true; return false; },
      onRemoved: e => { ids.delete(e.overlay.id); if (selectedId === e.overlay.id) { selectedId = null; pop.hidden = true; } if (!clearing) persist(); return false; },
    };
  }
  function create(o) {
    const id = chart.createOverlay({groupId: GROUP, mode: MAGNET[magnet][0], lock: locked, ...o, ...callbacks()});
    if (o.points) ids.add(id);
    return id;
  }
  function cancel() {
    if (drawingId) { chart.removeOverlay(drawingId); drawingId = null; }
    setActive(null);
  }
  function start(name) {
    cancel();
    let extendData;
    if (TEXT_TOOLS.has(name)) { extendData = prompt("텍스트 입력"); if (!extendData) return; }
    if (hidden) toggleHidden();
    drawingId = create({name, extendData});
    setActive(name);
  }
  function toggleHidden() {
    hidden = !hidden; q('[data-act="hide"]').setAttribute("aria-pressed", hidden);
    each(id => chart.overrideOverlay({id, visible: !hidden}));
  }
  function restyle({color, size}) {
    const o = selectedId && chart.getOverlayById(selectedId); if (!o) return;
    const s = o.styles || {}, st = {line: {...s.line}, polygon: {...s.polygon}, rect: {...s.rect}, circle: {...s.circle}, text: {...s.text}};
    if (color) {
      st.line.color = color; st.text.backgroundColor = color; st.text.borderColor = color;
      for (const k of ["polygon", "rect", "circle"]) { st[k].color = alpha(color, .15); st[k].borderColor = color; }
    }
    if (size) { st.line.size = size; for (const k of ["polygon", "rect", "circle"]) st[k].borderSize = size; }
    chart.overrideOverlay({id: selectedId, styles: st});
    persist();
  }

  bar.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.more) {
      const g = b.parentElement, open = !g.classList.contains("open");
      closeMenus(); g.classList.toggle("open", open);
      if (open) { // position: fixed 메뉴를 버튼 오른쪽에, 화면 안으로
        const r = g.getBoundingClientRect(), f = g.querySelector(".flyout");
        f.style.left = Math.max(8, Math.min(r.right + 6, innerWidth - f.offsetWidth - 8)) + "px";
        f.style.top = Math.max(8, Math.min(r.top, innerHeight - f.offsetHeight - 8)) + "px";
      }
      return;
    }
    closeMenus();
    if (b.dataset.tool) {
      const gi = b.dataset.g, tool = bar.querySelector(`.tool[data-g="${gi}"]`);
      current[gi] = b.dataset.tool; tool.innerHTML = icon(b.dataset.tool); tool.title = b.textContent.trim();
      return start(b.dataset.tool);
    }
    if (b.dataset.g) return activeTool === current[b.dataset.g] ? cancel() : start(current[b.dataset.g]);
    switch (b.dataset.act) {
      case "cursor": return cancel();
      case "magnet":
        magnet = (magnet + 1) % MAGNET.length; b.title = MAGNET[magnet][1]; b.setAttribute("aria-pressed", magnet > 0);
        return each(id => chart.overrideOverlay({id, mode: MAGNET[magnet][0]}));
      case "keep": keep = !keep; return b.setAttribute("aria-pressed", keep);
      case "lock": locked = !locked; b.setAttribute("aria-pressed", locked); return each(id => chart.overrideOverlay({id, lock: locked}));
      case "hide": return toggleHidden();
      case "clear": cancel(); clearing = true; [...ids].forEach(id => chart.removeOverlay(id)); clearing = false; ids.clear(); pop.hidden = true; persist(); return;
    }
  });
  pop.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.del !== undefined) return selectedId && chart.removeOverlay(selectedId);
    restyle({color: b.dataset.color, size: Number(b.dataset.size) || undefined});
  });
  document.addEventListener("click", e => { if (!bar.contains(e.target)) closeMenus(); });
  document.addEventListener("keydown", e => {
    if (e.target.closest("input, textarea")) return;
    if (e.key === "Escape") { closeMenus(); cancel(); }
    if ((e.key === "Delete" || e.key === "Backspace") && selectedId) chart.removeOverlay(selectedId);
  });

  // 종목 전환 시 그림을 종목별로 보관. factor = 그릴 당시의 누적 주식병합 배수
  function serialize() {
    return [...ids].map(id => chart.getOverlayById(id)).filter(Boolean)
      .map(o => ({name: o.name, points: o.points.map(p => ({timestamp: p.timestamp, value: p.value})), extendData: o.extendData, styles: o.styles}));
  }
  function persist(key = curKey, factor = curFactor) {
    if (!key) return;
    const items = serialize();
    saved[key] = {factor, items};
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch { /* 저장 불가 환경은 무시 */ }
    onSync?.({sym: key, factor, items});
  }
  function save(key, factor = 1) {
    persist(key, factor);
    cancel(); clearing = true; [...ids].forEach(id => chart.removeOverlay(id)); clearing = false; ids.clear(); pop.hidden = true;
  }
  function oldSaveUnused() {
    const items = [...ids].map(id => chart.getOverlayById(id)).filter(Boolean)
      .map(o => ({name: o.name, points: o.points.map(p => ({timestamp: p.timestamp, value: p.value})), extendData: o.extendData, styles: o.styles}));
    saved[key] = {factor, items};
    cancel(); [...ids].forEach(id => chart.removeOverlay(id)); ids.clear(); pop.hidden = true;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch { /* 저장 불가 환경은 무시 */ }
  }
  // 그 사이 주식병합이 있었으면 가격 좌표를 같은 배수로 옮겨서 다시 그린다 (예: 10:1 병합이면 ×10)
  // 새 시즌: 시작가가 바뀌어 예전 그림은 의미가 없다
  function clearAll() {
    cancel(); [...ids].forEach(id => chart.removeOverlay(id)); ids.clear(); pop.hidden = true;
    for (const k of Object.keys(saved)) delete saved[k];
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* 저장 불가 환경은 무시 */ }
  }
  function load(key, factor = 1) {
    curKey = key; curFactor = factor;
    cancel(); clearing = true; [...ids].forEach(id => chart.removeOverlay(id)); clearing = false; ids.clear(); pop.hidden = true;
    const entry = Array.isArray(saved[key]) ? {factor: 1, items: saved[key]} : saved[key]; // 예전 저장 형식 호환
    if (!entry) return;
    const k = factor / entry.factor;
    for (const o of entry.items) create({...o, points: o.points.map(p => ({...p, value: p.value * k}))});
  }

  // 도구 예시: 현재 데이터 위에 대표 도구를 한 번에 그림
  function demo() {
    const d = chart.getDataList(), n = d.length, scale = Math.min(1, (n - 1) / 130);
    const P = (back, k = 1, f = "close") => { const b = d[n - Math.max(1, Math.round(back * scale))]; return {timestamp: b.timestamp, value: b[f] * k}; };
    [
      {name: "segment", points: [P(110, 1, "low"), P(70, 1, "low")]},
      {name: "fibonacciLine", points: [P(100, 1, "low"), P(60, 1, "high")]},
      {name: "longPosition", points: [P(40), P(20, 1.03), P(40, .985)]},
      {name: "priceRange", points: [P(18, 1, "low"), P(8, 1, "high")]},
      {name: "elliottWave", points: [P(130, 1, "low"), P(124, 1, "high"), P(120, 1, "low"), P(112, 1, "high"), P(108, 1, "low"), P(102, 1, "high")]},
      {name: "rectShape", points: [P(60, 1.01), P(45, .99)]},
      {name: "textLabel", points: [P(30, 1.04)], extendData: "돌파 확인"},
      {name: "horizontalRayLine", points: [P(70, 1, "high")]},
    ].forEach(create);
    persist();
  }

  pop.hidden = true;
  function mergeRemote(remote) {
    if (!remote) return;
    for (const [k, v] of Object.entries(saved)) {
      const entry = Array.isArray(v) ? {factor: 1, items: v} : v;
      if (entry?.items?.length && !remote[k]?.items?.length) onSync?.({sym: k, factor: entry.factor || 1, items: entry.items});
    }
    for (const [k, v] of Object.entries(remote)) if (v?.items?.length) saved[k] = v;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch { /* 저장 불가 환경은 무시 */ }
    if (curKey && remote[curKey]?.items?.length) load(curKey, curFactor);
  }
  return {save, load, demo, clearAll, mergeRemote};
}

export { alpha };
