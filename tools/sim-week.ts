// 시즌을 실제 설정으로 돌려 가격이 터지거나 녹지 않는지, 신흥주 상장 변화가 적당한지 본다.
// 실행: node tools/sim-week.ts [seed...] [--days 7]
// seed가 여러 개면 seed마다 별도 프로세스로 동시에 돈다 (3개 기준 약 15초).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ASSETS, SECTORS, SPARES, createMarket } from "../packages/engine/src/index.ts";

const args = process.argv.slice(2);
const daysAt = args.indexOf("--days");
const days = daysAt >= 0 ? Number(args[daysAt + 1]) : 7;
const seeds = args.filter((_, i) => daysAt < 0 || (i !== daysAt && i !== daysAt + 1)).map(Number).filter(Boolean);

if (seeds.length > 1) {
  // 병렬: seed마다 자기 자신을 하나씩 띄우고 출력을 seed 순서대로 모은다
  const self = fileURLToPath(import.meta.url);
  const outputs = await Promise.all(seeds.map(seed => new Promise<string>(resolve => {
    let out = "";
    const p = spawn(process.execPath, [self, String(seed), "--days", String(days)]);
    p.stdout.on("data", d => (out += d));
    p.stderr.on("data", d => (out += d));
    p.on("close", () => resolve(out));
  })));
  process.stdout.write(outputs.join(""));
} else {
  run(seeds[0] ?? 1);
}

function run(seed: number) {
  const TICKS = days * 24 * 3600;
  const t0 = performance.now();
  const m = createMarket({ assets: ASSETS, sectors: SECTORS, spares: SPARES, seed, now: 1.79e12 });
  const count: Record<string, number> = {};
  const bump = (k: string) => (count[k] = (count[k] ?? 0) + 1);
  const LABELS: [string, string][] = [
    ["정규 시장 승격", "승격"], ["관리종목 지정", "관리종목"], ["관리종목 해제", "해제"], ["인수 제안", "인수"],
    ["유상증자", "증자"], ["주식병합", "병합"], ["신규 상장", "신규"],
  ];
  let news = 0;
  const gradHours: number[] = [];
  const hourly: Record<string, number[]> = {};
  for (let t = 1; t <= TICKS; t++) {
    const r = m.step();
    news += r.news.length;
    for (const n of r.news) {
      if (n.delisted) bump("폐지");
      if (n.headline.includes("정규 시장 승격")) gradHours.push(Math.round(t / 3600));
      for (const [needle, label] of LABELS) if (n.headline.includes(needle)) bump(label);
    }
    if (t % 3600 === 0) for (const a of ASSETS.filter(x => x.market !== "venture")) {
      const q = m.quote(a.sym);
      if (q) (hourly[a.sym] ??= []).push(q.price / a.price);
    }
  }
  const fmt = (x: number) => (x >= 10 ? x.toFixed(0) : x.toFixed(2));
  const listing = ["승격", "관리종목", "해제", "인수", "증자", "병합", "폐지", "신규"].map(k => `${k} ${count[k] ?? 0}`).join(" · ");
  const ventures = m.quotes().filter(q => q.market === "venture").length;
  let out = `seed ${seed} (${days}일, ${Math.round(performance.now() - t0)}ms): 뉴스 ${news}건, 신흥주 ${ventures}개, 게임 날짜 ${JSON.stringify(m.gameDate())}\n`;
  out += `  상장 변화: ${listing}\n  승격 시점(시작 후 시간): ${gradHours.join(", ") || "없음"}\n  가격 배수(시작가 대비): 일별 끝 값 | 1시간 간격 최저~최고\n`;
  for (const [sym, xs] of Object.entries(hourly)) {
    const daily = xs.filter((_, i) => (i + 1) % 24 === 0);
    out += `   ${sym.padEnd(5)} ${daily.map(fmt).join("  ")} | ${fmt(Math.min(...xs))}~${fmt(Math.max(...xs))}\n`;
  }
  process.stdout.write(out);
}
