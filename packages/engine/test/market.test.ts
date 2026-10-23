import assert from "node:assert/strict";
import { test } from "node:test";
import { ASSETS, SECTORS, SPARES, createMarket, type Market } from "../src/index.ts";

const NOW = 1_792_000_000_000;
// 테스트는 빠르게: 10틱 = 1봉, 과거 200봉
const FAST = { ticksPerBar: 10, warmupBars: 200 };
const make = (seed: number, options = {}) =>
  createMarket({ assets: ASSETS, sectors: SECTORS, spares: SPARES, seed, now: NOW, options: { ...FAST, ...options } });
const run = (m: Market, n: number) => { for (let i = 0; i < n; i++) m.step(); };

test("같은 seed면 같은 가격 경로", () => {
  const a = make(7), b = make(7);
  run(a, 3000); run(b, 3000);
  assert.deepEqual(a.quotes(), b.quotes());
  assert.deepEqual(a.news.slice(0, 20), b.news.slice(0, 20));
});

test("시작가는 설정값과 정확히 같고, 주식 PER은 적정 PER", () => {
  const m = make(1);
  for (const def of ASSETS) {
    const q = m.quote(def.sym)!;
    assert.ok(Math.abs(q.price / def.price - 1) < 1e-12, `${def.sym} 시작가`);
    if (def.fairPER) assert.ok(Math.abs(q.per! - def.fairPER) < 1e-9, `${def.sym} PER`);
    const bars = m.bars(def.sym);
    assert.equal(bars.length, FAST.warmupBars);
    assert.ok(Math.abs(bars[bars.length - 1].close / def.price - 1) < 1e-12, `${def.sym} 마지막 봉`);
  }
});

test("밖으로 나가는 시세·뉴스에 숨은 상태가 없다", () => {
  const m = make(2);
  run(m, 2000);
  const quoteKeys = ["cap", "market", "name", "parValue", "per", "prev", "price", "sector", "splitFactor", "stage", "sym"];
  for (const q of m.quotes()) assert.deepEqual(Object.keys(q).sort(), quoteKeys);
  const allowed = new Set(["id", "tick", "at", "date", "kind", "headline", "body", "symbols", "priceAt", "sector", "event", "delisted", "report"]);
  for (const n of m.news) for (const k of Object.keys(n)) assert.ok(allowed.has(k), `뉴스 필드 ${k}`);
});

test("봉은 시간 순서이고 OHLC가 일관된다", () => {
  const m = make(3);
  run(m, 5000);
  for (const q of m.quotes()) {
    const bars = m.bars(q.sym);
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      assert.ok(b.low <= Math.min(b.open, b.close) && b.high >= Math.max(b.open, b.close), `${q.sym} OHLC`);
      if (i) assert.ok(b.timestamp > bars[i - 1].timestamp, `${q.sym} 시간 순서`);
    }
  }
});

test("같은 업종은 다른 업종보다 같이 움직인다", () => {
  const m = make(4);
  run(m, 20000);
  const ret = (s: string) => { const c = m.bars(s).map(b => b.close); return c.slice(1).map((x, i) => Math.log(x / c[i])); };
  const corr = (x: number[], y: number[]) => {
    const n = Math.min(x.length, y.length); x = x.slice(-n); y = y.slice(-n);
    const mx = x.reduce((a, b) => a + b) / n, my = y.reduce((a, b) => a + b) / n;
    let sxy = 0, sx = 0, sy = 0;
    for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sx += (x[i] - mx) ** 2; sy += (y[i] - my) ** 2; }
    return sxy / Math.sqrt(sx * sy);
  };
  const same = (corr(ret("NVDA"), ret("AMD")) + corr(ret("GOOGL"), ret("META"))) / 2;
  const cross = (corr(ret("NVDA"), ret("META")) + corr(ret("AMD"), ret("GOOGL"))) / 2;
  assert.ok(same > cross + 0.15, `같은 업종 ${same.toFixed(2)} vs 다른 업종 ${cross.toFixed(2)}`);
});

test("시총 미달이면 관리종목을 거쳐서만 폐지되고, 새 신흥주가 상장한다", () => {
  // 모든 신흥주가 시총 기준에 걸리게 하고, 회생 이벤트는 끈다
  const m = make(5, { delistCap: 1e15, watchTicks: 200, rescueOdds: [0, 0] });
  const watched = new Set<string>();
  let delisted = 0, listed = 0;
  for (let i = 0; i < 2000; i++) {
    const r = m.step();
    for (const n of r.news) {
      if (n.headline.includes("관리종목 지정")) watched.add(n.symbols[0]);
      if (n.delisted) { delisted++; assert.ok(watched.has(n.symbols[0]), `${n.symbols[0]} 관리종목 없이 폐지`); }
      if (n.headline.includes("신규 상장")) listed++;
    }
    for (const a of r.actions) if (a.type === "delist") assert.ok(a.price > 0);
  }
  assert.ok(delisted > 0, "상장폐지 발생");
  assert.ok(listed > 0, "신규 상장 발생");
  assert.ok(m.quotes().filter(q => q.market === "venture").length <= 10);
});

test("관리종목 중 회생 이벤트가 나오고, 회복하면 해제된다", () => {
  const m = make(8, { delistCap: 2e8, watchTicks: 400, rescueOdds: [1, 0] }); // 회생 = 항상 인수 제안
  let acquire = 0, release = 0;
  for (let i = 0; i < 12000; i++) for (const n of m.step().news) {
    if (n.headline.includes("인수 제안")) acquire++;
    if (n.headline.includes("관리종목 해제")) release++;
  }
  assert.ok(acquire > 0, "인수 제안 발생");
  assert.ok(release > 0, "관리종목 해제 발생");
});

test("가격이 너무 낮으면 주식병합: 가격 ×ratio, 시총 그대로, 차트도 맞춘다", () => {
  const m = make(9, { splitPrice: 3 }); // $3 아래 신흥주는 병합
  for (let i = 0; i < 3000; i++) {
    const before = Object.fromEntries(m.quotes().map(q => [q.sym, q]));
    const r = m.step();
    const split = r.actions.find(a => a.type === "split");
    if (!split || split.type !== "split") continue;
    const q = m.quote(split.sym)!, prev = before[split.sym];
    assert.ok(split.ratio >= 10);
    assert.ok(q.price >= 3, "병합 뒤 가격이 기준 이상");
    assert.ok(Math.abs(q.cap! / (prev.cap! * (q.price / (prev.price * split.ratio))) - 1) < 1e-9, "시총 유지");
    assert.ok(Math.abs(m.bars(split.sym).at(-1)!.close / q.price - 1) < 1e-9, "차트 마지막 봉 = 현재가");
    assert.ok(r.news.some(n => n.headline.includes("주식병합")), "병합 뉴스");
    assert.equal(q.splitFactor, prev.splitFactor * split.ratio, "누적 병합 배수");
    assert.ok(Math.abs(q.parValue! / (prev.parValue! * split.ratio) - 1) < 1e-12, "액면가 ×ratio");
    return;
  }
  assert.fail("주식병합이 일어나지 않음");
});

test("호가창 순매수의 영구 몫(absorbFlow): 제곱근 크기, 상한, 30%만 기준가에 남는다", () => {
  const move = (sym: string, notional: number) => { const m = make(11), pre = m.quote(sym)!.price; m.absorbFlow(sym, notional); return Math.log(m.quote(sym)!.price / pre); };
  const small = move("NVDA", 1e6), big = move("NVDA", 4e6);
  assert.ok(small > 0 && Math.abs(big / small - 2) < 1e-9, "4배 금액 → 2배");
  assert.ok(move("NVDA", -1e6) < 0, "순매도는 내린다");
  assert.ok(Math.abs(move("LMQ", 1e12) - 0.15 * 0.3) < 1e-12, "신흥주 상한 15%의 30%");
  // 같은 seed에서 흡수한 쪽과 안 한 쪽은 그만큼 벌어진 채로 같은 경로를 간다 (적정가도 같이 옮겨서 되돌아가지 않는다)
  const x = make(20), y = make(20);
  x.absorbFlow("NVDA", 3e7);
  const gap = Math.log(x.quote("NVDA")!.price / y.quote("NVDA")!.price);
  run(x, 61); run(y, 61);
  assert.ok(Math.abs(Math.log(x.quote("NVDA")!.price / y.quote("NVDA")!.price) - gap) < gap * 0.5, "61틱 뒤에도 대부분 남음");
});

test("검증 성공 + 시총 기준이면 주식으로 승격한다", () => {
  const m = make(6, { gradCap: 0, gradSuccesses: 1, gradCooldown: 0 }); // 성공 1회면 바로 승격
  let graduated: string | null = null;
  for (let i = 0; i < 20000 && !graduated; i++) {
    const n = m.step().news.find(x => x.headline.includes("정규 시장 승격"));
    if (n) graduated = n.symbols[0];
  }
  assert.ok(graduated, "승격 발생");
  const q = m.quote(graduated!)!;
  assert.equal(q.market, "stock");
  assert.equal(q.sector, "newgrowth");
  assert.ok(q.per && Math.abs(q.per - 15) < 1e-9, "승격 시 PER 15");
});

test("승격에 상한이 없고, 예비 기업이 바닥나면 이름을 지어 신흥주 10개를 채운다", () => {
  const m = createMarket({ assets: ASSETS, sectors: SECTORS, spares: [], seed: 6, now: NOW, options: { ...FAST, gradCap: 0, gradSuccesses: 1 } });
  const known = new Set(ASSETS.map(a => a.sym));
  let grads = 0;
  for (let i = 0; i < 60000 && grads < 12; i++) grads += m.step().actions.filter(x => x.type === "graduate").length;
  run(m, 100); // 빈자리 상장 (40~80틱 뒤)
  const qs = m.quotes();
  assert.ok(grads >= 12, `승격 ${grads}개 (상한 10 넘음)`);
  assert.equal(qs.filter(q => q.market === "venture").length, 10, "신흥주는 늘 10개");
  assert.ok(qs.some(q => q.market === "venture" && !known.has(q.sym)), "지어 낸 신흥주가 상장됨");
});

test("스냅샷에서 이어 돌리면 끊김 없이 같은 경로", () => {
  const a = make(12);
  run(a, 3000);
  a.absorbFlow("NVDA", 5e6);
  const snap = a.snapshot();
  const b = createMarket({ assets: ASSETS, sectors: SECTORS, spares: SPARES, seed: 12, now: NOW, options: FAST, snapshot: snap });
  assert.equal(b.tick, a.tick);
  run(a, 4000); run(b, 4000);
  assert.deepEqual(b.quotes(), a.quotes());
  assert.deepEqual(b.news.slice(0, 30), a.news.slice(0, 30));
  assert.deepEqual(b.bars("LMQ").slice(-50), a.bars("LMQ").slice(-50));
});

test("등락률 기준가(prev)는 게임 하루(80틱)마다 초기화된다", () => {
  const m = make(15);
  // warmupBars=200 * ticksPerBar=10 = 2000틱에서 시작. 다음 하루 경계는 2080틱.
  const initialPrev = m.quote("NVDA")!.prev;
  run(m, 40);
  assert.equal(m.quote("NVDA")!.prev, initialPrev, "하루 중간에는 기준가 유지");
  run(m, 40);
  assert.equal(m.tick, 2080);
  assert.equal(m.quote("NVDA")!.prev, m.quote("NVDA")!.price, "게임 하루마다 기준가 갱신");
});

test("시즌 우상향은 seasonGrowth 범위 안 (폭주 없음)", () => {
  // 시즌 6,000틱에 1.5~3배. 뉴스·세력 쏠림이 남아 있으면 중앙값이 범위를 크게 벗어난다
  for (const seed of [21, 22, 23]) {
    const m = make(seed, { seasonTicks: 6000 });
    run(m, 6000);
    const mult = m.quotes().filter(q => q.market === "stock" && ASSETS.some(a => a.sym === q.sym && a.market === "stock"))
      .map(q => q.price / ASSETS.find(a => a.sym === q.sym)!.price).sort((a, b) => a - b);
    const median = mult[Math.floor(mult.length / 2)];
    assert.ok(median > 1.2 && median < 4, `seed ${seed} 주식 중앙 배수 ${median.toFixed(2)}x`);
    assert.ok(mult.at(-1)! < 15, `seed ${seed} 최고 배수 ${mult.at(-1)!.toFixed(2)}x`);
  }
});

test("코인 섹터 동조화·개별 기업 뉴스 단독 반응", () => {
  const m = make(21);
  run(m, 6000);

  // 코인 섹터 동조화 확인 (BTC - ETH 상관관계)
  const ret = (s: string) => { const c = m.bars(s).map(b => b.close); return c.slice(1).map((x, i) => Math.log(x / c[i])); };
  const x = ret("BTC"), y = ret("ETH"), n = Math.min(x.length, y.length);
  const mx = x.slice(-n).reduce((a, b) => a + b) / n, my = y.slice(-n).reduce((a, b) => a + b) / n;
  let sxy = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[x.length - n + i] - mx, dy = y[y.length - n + i] - my;
    sxy += dx * dy; sx += dx * dx; sy += dy * dy;
  }
  const coinCorr = sxy / Math.sqrt(sx * sy);
  assert.ok(coinCorr > 0.4, `코인 섹터 동조화 상관계수 ${coinCorr.toFixed(2)}`); // 2026-10-23 코인 개별 뉴스를 키워 0.45 → 0.4

  // 개별 기업·코인 뉴스는 오직 해당 1개 종목만 대상으로 한다
  for (const item of m.news) {
    if (item.kind === "기업" || item.kind === "코인") {
      assert.equal(item.symbols.length, 1, "개별 기업·코인 뉴스는 해당 종목 1개만 반응");
    }
  }
});
