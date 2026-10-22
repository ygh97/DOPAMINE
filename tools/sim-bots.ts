// 봇 100명 + 🏦 세력 8개를 실제 Broker(메모리 DB)로 시즌 1개(8시간) 돌려 100배 졸업률을 잰다.
// 목표: 100명 중 약 10명(8~12명) 졸업, 한 성향이 거의 다 졸업하지 않을 것 (수정계획 A5).
// 실행: node --disable-warning=ExperimentalWarning tools/sim-bots.ts [seed...] [--bots 100] [--no-mm] [--opt '{"ventureSuccess":0.55}']
// seed가 여러 개면 seed마다 별도 프로세스로 동시에 돈다.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
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
  const totals = outs.map(o => /졸업 (\d+)\/(\d+)/.exec(o)).filter(Boolean).map(m => [Number(m![1]), Number(m![2])]);
  const g = totals.reduce((s, [a]) => s + a, 0), n = totals.reduce((s, [, b]) => s + b, 0);
  console.log(`== 전체: 봇 졸업 ${g}/${n} (${((g / Math.max(1, n)) * 100).toFixed(1)}%), 시즌당 평균 ${(g / Math.max(1, totals.length)).toFixed(1)}명`);
} else {
  run(seeds[0] ?? 1);
}

function run(seed: number) {
  const t0 = performance.now(), T0 = 1.79e12, SEASON_MS = 28_800_000;
  const db = openDb(":memory:");
  const season = currentSeason(db, seed, 1000, SEASON_MS, T0);
  const { market } = bootMarket(db, season, JSON.parse(OPT), T0);
  const broker = new Broker(db, season, market);
  const bots = new BotRunner(db, () => broker, () => market, { bots: BOTS, marketMakers: MM, seed });
  const start = Object.fromEntries(market.quotes().map(q => [q.sym, q.price]));
  let grads = 0, liqs = 0;
  const botIds = bots.describe().filter(d => d.kind === "bot").map(d => d.userId);
  const peak = new Map<number, number>(); // 봇별 시즌 중 최고 배수 (졸업 목표를 바꿔 볼 때 쓴다)
  for (let i = 0; i < SEASON_MS / 1000; i++) {
    broker.settle();
    const r = market.step();
    broker.applyActions(r.actions);
    broker.checkTriggers();
    bots.tick(r.news);
    for (const a of r.actions) if (a.type === "graduate") grads++;
    for (const t of broker.drainBroadcasts()) if (t.startsWith("[강제청산]")) liqs++;
    if (i % 5 === 0) broker.ranking(1); // 서버처럼 5 tick마다 랭킹을 계산해야 100배 졸업 시점이 기록된다
    if (i % 10 === 0) for (const id of botIds) peak.set(id, Math.max(peak.get(id) ?? 0, broker.equity(broker.account(id)) / 100_000));
  }
  const reached = (x: number) => [...peak.values()].filter(v => v >= x).length;
  broker.settle();
  const who = new Map(bots.describe().map(d => [broker.account(d.userId).name, d]));
  const rows = broker.ranking(Infinity), mm = broker.mmRanking();
  const cleared = rows.filter(r => r.clearedTick != null);
  const byStyle = new Map<string, { n: number; cleared: number; best: number }>();
  for (const r of rows) {
    const s = who.get(r.name)?.label ?? "?", e = byStyle.get(s) ?? { n: 0, cleared: 0, best: 0 };
    e.n++; if (r.clearedTick != null) e.cleared++; e.best = Math.max(e.best, r.equity / 100_000);
    byStyle.set(s, e);
  }
  const mult = rows.map(r => r.equity / 100_000).sort((a, b) => a - b);
  const stockMult = market.quotes().filter(q => q.market === "stock" && start[q.sym]).map(q => q.price / start[q.sym]).sort((a, b) => a - b);
  const ventMax = Math.max(...market.quotes().filter(q => q.market === "venture" && start[q.sym]).map(q => q.price / (start[q.sym] * (q.splitFactor ?? 1)))); // 병합하면 가격이 ×ratio 되므로 나눠서 비교
  console.log(`seed ${seed} (${((performance.now() - t0) / 1000).toFixed(0)}초): 졸업 ${cleared.length}/${rows.length} · 최종 중앙 ${mult[Math.floor(mult.length / 2)].toFixed(2)}배 · 1위 ${(mult.at(-1)! ).toFixed(1)}배 · 강제청산 ${liqs}회 · 승격 ${grads} · 주식 중앙 ${stockMult[Math.floor(stockMult.length / 2)].toFixed(2)}배 · 신흥주 최고 ${ventMax.toFixed(1)}배`);
  console.log(`  도달 [10배 ${reached(10)} · 20배 ${reached(20)} · 30배 ${reached(30)} · 50배 ${reached(50)} · 100배 ${reached(100)}]`);
  console.log("  성향별 졸업: " + [...byStyle].map(([s, e]) => `${s} ${e.cleared}/${e.n}(최고 ${e.best.toFixed(1)}배)`).join(", "));
  if (mm.length) console.log("  세력 수익률: " + mm.map(r => `${who.get(r.name)?.label ?? r.name} ${r.returnPct >= 0 ? "+" : ""}${r.returnPct.toFixed(1)}%`).join(", "));
  void GOAL;
}
