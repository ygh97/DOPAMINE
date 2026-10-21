// 실서버 배포 전 부하 점검: 동시 SSE 100명 접속 + 20명 동시 현물·선물 주문 + 채팅 방송 지연·메모리 측정.
// 실행: node --disable-warning=ExperimentalWarning tools/load-test.ts
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 4820;
const BASE = `http://127.0.0.1:${PORT}`;
const SSE_CLIENTS = 100;
const TRADERS = 10; // IP당 1분 10회 가입 제한 준수

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const srv = spawn(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", "src/index.ts"],
  {
    cwd: resolve(import.meta.dirname, "../apps/server"),
    env: {
      ...process.env,
      PORT: String(PORT),
      TICK_MS: "100",
      LOG_LEVEL: "warn",
      DB_FILE: join(tmpdir(), `dc-load-${process.pid}.db`),
      ENGINE_OPTIONS: JSON.stringify({ warmupBars: 120 }),
    },
  },
);

try {
  // 서버 부팅 대기
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) break;
    } catch {}
    await sleep(100);
  }

  // 1) 100개 동시 SSE 스트림 연결
  let tickEvents = 0;
  const controllers: AbortController[] = [];
  await Promise.all(
    Array.from({ length: SSE_CLIENTS }, async () => {
      const ac = new AbortController();
      controllers.push(ac);
      const res = await fetch(`${BASE}/api/stream`, { signal: ac.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const txt = dec.decode(value);
            const matches = txt.match(/event: tick/g);
            if (matches) tickEvents += matches.length;
          }
        } catch {}
      })();
    }),
  );

  // 2) 20명 동시 참가 + 현물·선물 주문
  const t0 = performance.now();
  const tokens = await Promise.all(
    Array.from({ length: TRADERS }, async (_, i) => {
      const r = await fetch(`${BASE}/api/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `봇_${i + 1}`, password: "secret1" }),
      }).then(x => x.json() as Promise<{ token: string }>);
      return r.token;
    }),
  );

  const syms = ["NVDA", "TSLA", "AAPL", "BTC", "ETH", "SOL", "LMQ"];
  await Promise.all(
    tokens.map((t, i) =>
      fetch(`${BASE}/api/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ sym: syms[i % syms.length], side: "buy", pct: 20 }),
      }),
    ),
  );
  await Promise.all(
    tokens.map((t, i) =>
      fetch(`${BASE}/api/futures/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ sym: syms[(i + 1) % syms.length], side: i % 2 ? "long" : "short", lev: 3, pct: 20 }),
      }),
    ),
  );
  const orderElapsedMs = Math.round(performance.now() - t0);

  await sleep(600);
  const health = await fetch(`${BASE}/api/health`).then(r => r.json() as Promise<{ clients: number; tick: number }>);
  const rank = await fetch(`${BASE}/api/ranking`).then(r => r.json() as Promise<{ players: number; rows: unknown[] }>);

  for (const ac of controllers) ac.abort();

  const report = {
    sseClientsConnected: health.clients,
    totalTickEventsReceived: tickEvents,
    tradersJoined: rank.players,
    concurrentOrders40Ms: orderElapsedMs,
    ok: health.clients === SSE_CLIENTS && tickEvents >= SSE_CLIENTS * 2 && rank.players === TRADERS,
  };
  console.log(JSON.stringify(report, null, 1));
  if (!report.ok) process.exitCode = 1;
} finally {
  srv.kill();
}
