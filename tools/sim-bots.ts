// 봇 100명 + 🏦 세력·🐋 고래를 실제 Broker·호가창(메모리 DB)으로 시즌 1개(8시간) 돌려 졸업률을 잰다.
// 목표 (docs/M8-호가창-설계.md 8장): 20배 졸업 약 9%, 100배 전설 2~3%, 주식 중앙값 1.5~3배, 거품 주식 ±30% 정도,
// 호가 봇 손익이 한쪽으로 쏠리지 않을 것, tick 계산이 1초보다 훨씬 짧을 것.
// 실행: node --disable-warning=ExperimentalWarning tools/sim-bots.ts [seed...] [--bots 100] [--no-mm] [--opt '{"ventureSuccess":0.55}']
// seed가 여러 개면 seed마다 별도 프로세스로 동시에 돈다.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ASSETS } from "@dopamine/engine";
import { BotRunner } from "../apps/server/src/bots.ts";
import { Broker, GOAL } from "../apps/server/src/broker.ts";
import { openDb } from "../apps/server/src/db.ts";
import { bootMarket, currentSeason } from "../apps/server/src/season.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const BOTS = Number(flag("--bots") ?? 100), MM = !args.includes("--no-mm"), OPT = flag("--opt") ?? "{}";
const seeds = args.filter((a, i) => /^\d+$/.test(a) && !["--bots"].includes(args[i - 1])).map(Number);

if (seeds.length > 1) {
  const self = fileURLToPath(import.meta.url), rest = args.filter(a => !seeds.includes(Number(a)) || !/^\d+$/.test(a));
  const outs = await Promise.all(seeds.map(seed => new Promise<string>(resolve => {
    let out = "";
    const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", self, String(seed), ...rest]);
    p.stdout.on("data", d => (out += d)); p.stderr.on("data", d => (out += d)); p.on("close", () => resolve(out));
  })));
  process.stdout.write(outs.join(""));
  const totals = outs.map(o => /졸업 (\d+) · 전설 (\d+) \/ (\d+)명 · 100배 도달 (\d+)/.exec(o)).filter(Boolean).map(m => [Number(m![1]), Number(m![2]), Number(m![3]), Number(m![4])]);
  const nums = (re: RegExp) => outs.map(o => re.exec(o)).filter(Boolean).map(m => Number(m![1]));
  const med = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const sum = (k: number) => totals.reduce((s, t) => s + t[k], 0), n = Math.max(1, sum(2));
  console.log(`== 전체 ${sum(2)}명: 20배 졸업 ${sum(0)} (${((sum(0) / n) * 100).toFixed(1)}%) · 100배 전설(시즌 끝 유지) ${sum(1)} (${((sum(1) / n) * 100).toFixed(1)}%) · 100배 도달 ${sum(3)} (${((sum(3) / n) * 100).toFixed(1)}%)`
    + ` · 주식 중앙 ${med(nums(/주식 중앙 ([\d.]+)배/))}배 · 거품 최대 ${Math.max(...nums(/거품 주식 \+([\d.]+)%/))}% · tick 최대 ${Math.max(...nums(/tick 평균 [\d.]+ms · 최대 ([\d.]+)ms/))}ms`);
} else {
  run(seeds[0] ?? 1);
}

function run(seed: number) {
  const t0 = performance.now(), T0 = 1.79e12, SEASON_MS = 28_800_000;
  const db = openDb(":memory:");
  const season = currentSeason(db, seed, 1000, SEASON_MS, T0);
  const { market, exchange } = bootMarket(db, season, JSON.parse(OPT), T0);
  const broker = new Broker(db, season, exchange);
  const bots = new BotRunner(db, () => broker, () => exchange, { bots: BOTS, marketMakers: MM, seed });
  const start = Object.fromEntries(exchange.quotes().map(q => [q.sym, q.price]));
  let grads = 0, liqs = 0;
  const botIds = bots.describe().filter(d => d.kind === "bot").map(d => d.userId);
  const peak = new Map<number, number>(); // 봇별 시즌 중 최고 배수 (졸업 목표를 바꿔 볼 때 쓴다)
  const fairPER = new Map(ASSETS.filter(a => a.fairPER).map(a => [a.sym, a.fairPER!]));
  const everGrad = new Set<string>(), everLegend = new Set<string>();
  let bubbleUp = 0, bubbleDown = 0, offRef = 0, tickSum = 0, tickMax = 0;
  for (let i = 0; i < SEASON_MS / 1000; i++) {
    const t1 = performance.now();
    broker.endTick();
    const r = exchange.step();
    broker.refundCancelled(r.cancelled);
    broker.settleTrades(r.trades);
    broker.applyActions(r.actions);
    broker.runTriggers();
    bots.tick(r.news);
    for (const a of r.actions) if (a.type === "graduate") grads++;
    for (const t of broker.drainBroadcasts()) if (t.startsWith("[강제청산]")) liqs++;
    if (i % 5 === 0) { // 서버처럼 5 tick마다 랭킹을 계산해야 졸업·전설 시점이 기록된다. 봇은 $3만 아래면 기록이 지워진 새 봇으로 바뀌니 한 번이라도 달성한 봇(이름별)을 센다
      broker.ranking(1);
      for (const id of botIds) { const acc = broker.account(id); if (acc.gradTick != null) everGrad.add(`${id}:${acc.name}`); if (acc.clearedTick != null) everLegend.add(`${id}:${acc.name}`); }
    }
    if (i % 10 === 0) for (const id of botIds) peak.set(id, Math.max(peak.get(id) ?? 0, broker.equity(broker.account(id)) / 100_000));
    const dt = performance.now() - t1; tickSum += dt; tickMax = Math.max(tickMax, dt);
    if (i % 60 === 0) for (const q of exchange.quotes()) {
      // 거품: 적정가(PER 기준) 대비 괴리 (주식만, 승격주는 적정 PER 15). 호가창 가격과 엔진 기준가의 차이도 본다
      if (q.market === "stock" && q.per) { const d = q.per / (fairPER.get(q.sym) ?? 15) - 1; bubbleUp = Math.max(bubbleUp, d); bubbleDown = Math.min(bubbleDown, d); }
      offRef = Math.max(offRef, Math.abs(q.price / exchange.reference(q.sym) - 1));
    }
  }
  const maker = { stock: 0, coin: 0, venture: 0 } as Record<string, number>;
  for (const q of exchange.quotes()) maker[q.market] += exchange.makerBook(q.sym)?.value ?? 0;
  const reached = (x: number) => [...peak.values()].filter(v => v >= x).length;
  broker.endTick();
  const who = new Map(bots.describe().map(d => [broker.account(d.userId).name, d]));
  const rows = broker.ranking(Infinity), mm = [...broker.mmRanking(), ...broker.whaleRanking()];
  const graduated = { length: everGrad.size }; // 봇 자리 100개 기준 (교체된 봇 포함)
  const cleared = rows.filter(r => r.clearedTick != null); // 전설 = 시즌 끝에 100배 이상 (100배를 유지해야 전설)
  const byStyle = new Map<string, { n: number; cleared: number; best: number }>();
  for (const r of rows) {
    const s = who.get(r.name)?.label ?? "?", e = byStyle.get(s) ?? { n: 0, cleared: 0, best: 0 };
    e.n++; if (r.gradTick != null) e.cleared++; e.best = Math.max(e.best, r.equity / 100_000);
    byStyle.set(s, e);
  }
  const mult = rows.map(r => r.equity / 100_000).sort((a, b) => a - b);
  const stockMult = exchange.quotes().filter(q => q.market === "stock" && start[q.sym]).map(q => q.price / start[q.sym]).sort((a, b) => a - b);
  const ventMax = Math.max(...exchange.quotes().filter(q => q.market === "venture" && start[q.sym]).map(q => q.price / (start[q.sym] * (q.splitFactor ?? 1)))); // 병합하면 가격이 ×ratio 되므로 나눠서 비교
  console.log(`seed ${seed} (${((performance.now() - t0) / 1000).toFixed(0)}초): 졸업 ${graduated.length} · 전설 ${cleared.length} / ${rows.length}명 · 100배 도달 ${everLegend.size} · 최종 중앙 ${mult[Math.floor(mult.length / 2)].toFixed(2)}배 · 1위 ${(mult.at(-1)! ).toFixed(1)}배 · 강제청산 ${liqs}회 · 승격 ${grads} · 주식 중앙 ${stockMult[Math.floor(stockMult.length / 2)].toFixed(2)}배 · 신흥주 최고 ${ventMax.toFixed(1)}배`);
  console.log(`  도달 [10배 ${reached(10)} · 20배 ${reached(20)} · 30배 ${reached(30)} · 50배 ${reached(50)} · 100배 ${reached(100)}]`);
  console.log("  성향별 졸업: " + [...byStyle].map(([s, e]) => `${s} ${e.cleared}/${e.n}(최고 ${e.best.toFixed(1)}배)`).join(", "));
  console.log(`  거품 주식 +${(bubbleUp * 100).toFixed(0)}% / ${(bubbleDown * 100).toFixed(0)}% · 호가-기준가 최대 ${(offRef * 100).toFixed(1)}% · 호가 봇 손익 주식 $${(maker.stock / 1e6).toFixed(2)}M 코인 $${(maker.coin / 1e6).toFixed(2)}M 신흥주 $${(maker.venture / 1e6).toFixed(2)}M · tick 평균 ${(tickSum / (SEASON_MS / 1000)).toFixed(2)}ms · 최대 ${tickMax.toFixed(0)}ms`);
  if (mm.length) console.log("  세력 수익률: " + mm.map(r => `${who.get(r.name)?.label ?? r.name} ${r.returnPct >= 0 ? "+" : ""}${r.returnPct.toFixed(1)}%`).join(", "));
  void GOAL;
}
