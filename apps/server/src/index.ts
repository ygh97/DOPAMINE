// 도파민 센터 서버: 벽시계 기준 GameLoop + SSE 시세 방송 + 참가·현물 주문.
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SECTORS, type Bar, type NewsItem, type Quote } from "@dopamine/engine";
import { Auth, AuthError } from "./auth.ts";
import { Broker, OrderError } from "./broker.ts";
import { Chat, ChatError } from "./chat.ts";
import { backupDb, openDb } from "./db.ts";
import { bootMarket, currentSeason, endTick, finishSeason, hallOfFame, saveSnapshot, targetTick } from "./season.ts";

const PORT = Number(process.env.PORT ?? 4810);
const HOST = process.env.HOST ?? "127.0.0.1";
const SEED = Number(process.env.SEED ?? 20261021);
const TICK_MS = Number(process.env.TICK_MS ?? 1000);
const SEASON_MS = Number(process.env.SEASON_MS ?? 7 * 24 * 3600 * 1000); // 시즌 길이 (새 시즌부터 적용)
const SNAPSHOT_EVERY = 600; // tick마다 엔진 스냅샷 저장 (10분)
const DB_FILE = process.env.DB_FILE ?? fileURLToPath(new URL("../../../data/dopamine.db", import.meta.url));
const BACKUP_DIR = process.env.BACKUP_DIR ?? join(dirname(DB_FILE), "backups");
const WEB_DIST = process.env.WEB_DIST ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
// ENGINE_OPTIONS: 테스트용 엔진 설정 덮어쓰기 (JSON). 예: {"splitPrice":1000,"warmupBars":120}
const ENGINE_OPTIONS = JSON.parse(process.env.ENGINE_OPTIONS ?? "{}");

const db = openDb(DB_FILE);
const ADMIN_KEY = process.env.ADMIN_KEY ?? "dopamine-admin";
const auth = new Auth(db);
const chat = new Chat(db);
// 시즌이 바뀌면 아래 넷을 통째로 갈아 끼운다
const bootStart = performance.now();
let season = currentSeason(db, SEED, TICK_MS, SEASON_MS);
let { market, warmTicks, replayed, fromSnapshot } = bootMarket(db, season, ENGINE_OPTIONS);
let broker = new Broker(db, season, market);
broker.loadAll();
saveSnapshot(db, season, market); // 다음 재시작은 여기서부터
const bootMs = Math.round(performance.now() - bootStart);

/** 시즌 종료: 명예의 전당 기록 → 새 시즌 시작 → 모두에게 알림 */
function rollover() {
  const prev = season.id;
  season = finishSeason(db, season, broker.ranking(Infinity));
  ({ market, warmTicks, replayed, fromSnapshot } = bootMarket(db, season, ENGINE_OPTIONS));
  broker = new Broker(db, season, market);
  saveSnapshot(db, season, market);
  app.log.info(`시즌 ${prev} 종료 → 시즌 ${season.id} 시작 (seed ${season.seed})`);
  send("season", seasonInfo());
}
const seasonInfo = () => ({ id: season.id, startedAt: season.startedAt, endsAt: season.startedAt + season.lengthMs });

// JSON 크기를 줄이려고 유효숫자 7자리로 자른다 ($94,880.10, $0.3121 모두 충분)
const r7 = (v: number) => Number(v.toPrecision(7));
const packBar = (b: Bar) => [b.timestamp, r7(b.open), r7(b.high), r7(b.low), r7(b.close), b.volume];
const packQuote = (q: Quote) => ({ ...q, price: r7(q.price), prev: r7(q.prev), per: q.per && r7(q.per), cap: q.cap && Math.round(q.cap) });

function snapshot() {
  return { tick: market.tick, date: market.gameDate(), season: seasonInfo(), sectors: SECTORS, quotes: market.quotes().map(packQuote), news: market.news.slice(0, 50), chat: chat.recent(50) };
}

// ---------- SSE ----------
type Client = { write: (chunk: string) => boolean };
const clients = new Set<Client>();
const settledLog: { tick: number; type: string; sym: string }[] = [];
const splitLog: { tick: number; sym: string }[] = [];
let lastAssetsTick = 0;
const send = (event: string, data: unknown) => {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(chunk);
};

// ---------- GameLoop ----------
// 벽시계가 가리키는 tick까지 따라잡는다. 늦었으면 여러 tick을 한 번에 돌리고 방송은 마지막 상태만.
const loop = setInterval(() => {
  const end = endTick(season, warmTicks);
  if (market.tick >= end) return rollover();
  const target = Math.min(targetTick(season, warmTicks), end);
  if (market.tick >= target) return;
  const news: NewsItem[] = [], reload: string[] = [], settled: { type: string; sym: string }[] = [];
  let assetsChanged = false;
  while (market.tick < target) {
    settled.push(...broker.settle());
    const result = market.step();
    if (broker.applyActions(result.actions).length)
      for (const a of result.actions) if (a.type === "split" || a.type === "delist") settled.push({ type: a.type, sym: a.sym });
    broker.checkTriggers();
    news.push(...[...result.news].reverse());
    for (const a of result.actions) if (a.type === "split") reload.push(a.sym);
    assetsChanged ||= result.assetsChanged;
    if (market.tick % SNAPSHOT_EVERY === 0) saveSnapshot(db, season, market);
  }
  for (const n of news.slice(-50)) send("news", n);
  // 상장 변화: 목록 갱신. 주식병합된 종목은 과거 차트가 바뀌었으니 다시 받으라고 알린다
  if (assetsChanged) { lastAssetsTick = market.tick; for (const s of reload) splitLog.push({ tick: market.tick, sym: s }); send("assets", { quotes: market.quotes().map(packQuote), reload }); }
  // 보유 종목이 병합·폐지로 정산됐다: 그 종목을 가진 사람은 계좌를 다시 받는다
  if (settled.length) { for (const s of settled) settledLog.push({ tick: market.tick, ...s }); if (settledLog.length > 200) settledLog.splice(0, settledLog.length - 200); send("settled", settled); }
  if (!clients.size) return;
  // 종목별 [timestamp, open, high, low, close, volume, 전일 종가]
  const bars: Record<string, number[]> = {};
  for (const q of market.quotes()) {
    const b = market.bars(q.sym).at(-1);
    if (b) bars[q.sym] = [...packBar(b), r7(q.prev)];
  }
  send("tick", { tick: market.tick, date: market.gameDate(), bars });
  if (market.tick % 5 === 0) send("ranking", { rows: broker.ranking(20), players: broker.players });
}, Math.max(10, Math.min(250, TICK_MS / 2)));

// ---------- HTTP ----------
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof AuthError || err instanceof OrderError || err instanceof ChatError) return reply.code(400).send({ error: err.message });
  if ((err as { validation?: unknown }).validation) return reply.code(400).send({ error: "요청 형식이 올바르지 않습니다." });
  app.log.error(err);
  return reply.code(500).send({ error: "서버 오류가 났습니다." });
});

function userOf(req: FastifyRequest, reply: FastifyReply): number | null {
  const id = auth.userOf(req.headers.authorization);
  if (!id) void reply.code(401).send({ error: "참가가 필요합니다." });
  return id;
}

// 참가 시도 속도 제한: IP당 1분에 10번
const joinTries = new Map<string, number[]>();
function joinAllowed(ip: string) {
  const now = Date.now(), recent = (joinTries.get(ip) ?? []).filter(t => now - t < 60_000);
  recent.push(now); joinTries.set(ip, recent);
  return recent.length <= 10;
}

app.get("/api/snapshot", async () => snapshot());

app.get<{ Querystring: { tick?: string } }>("/api/poll", async req => {
  const since = Number(req.query.tick) || market.tick;
  const bars: Record<string, number[]> = {};
  for (const q of market.quotes()) {
    const b = market.bars(q.sym).at(-1);
    if (b) bars[q.sym] = [...packBar(b), r7(q.prev)];
  }
  const settled = settledLog.filter(s => s.tick > since).map(({ type, sym }) => ({ type, sym }));
  const reload = [...new Set(splitLog.filter(s => s.tick > since).map(s => s.sym))];
  return {
    tick: market.tick,
    date: market.gameDate(),
    season: seasonInfo(),
    bars,
    news: market.news.filter(n => n.tick > since).slice(0, 30).reverse(),
    chat: chat.recent(50),
    ranking: { rows: broker.ranking(20), players: broker.players },
    settled: settled.length ? settled : undefined,
    assets: lastAssetsTick > since ? { quotes: market.quotes().map(packQuote), reload } : undefined,
  };
});

app.get<{ Querystring: { sym?: string; limit?: string } }>("/api/bars", async (req, reply) => {
  const sym = req.query.sym ?? "";
  if (!market.quote(sym)) return reply.code(404).send({ error: "종목을 찾을 수 없습니다." });
  const limit = Math.min(1500, Math.max(1, Number(req.query.limit) || 1500));
  return { sym, bars: market.bars(sym).slice(-limit).map(packBar) };
});

app.get<{ Querystring: { before?: string; limit?: string } }>("/api/news", async req => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const before = Number(req.query.before) || Infinity;
  return { news: market.news.filter(n => n.tick < before).slice(0, limit) };
});

app.get("/api/hall", async () => ({ rows: hallOfFame(db) }));

app.get("/api/ranking", async () => ({ rows: broker.ranking(20), players: broker.players }));

app.post<{ Body: { name: string; password: string } }>("/api/join", {
  schema: { body: { type: "object", required: ["name", "password"], properties: { name: { type: "string", maxLength: 40 }, password: { type: "string", maxLength: 64 } } } },
}, async (req, reply) => {
  if (!joinAllowed(req.ip)) return reply.code(429).send({ error: "참가 시도가 너무 많습니다. 1분 뒤에 다시 시도하세요." });
  const { token, userId, name, created } = auth.join(req.body.name, req.body.password);
  return { token, name, created, me: broker.me(userId) };
});

app.post("/api/logout", async req => { auth.logout(req.headers.authorization); return { ok: true }; });

app.get("/api/me", async (req, reply) => {
  const id = userOf(req, reply);
  return id && broker.me(id);
});

app.post<{ Body: { sym: string; side: string; pct: number } }>("/api/order", {
  schema: { body: { type: "object", required: ["sym", "side", "pct"], properties: { sym: { type: "string", maxLength: 10 }, side: { type: "string" }, pct: { type: "number" } } } },
}, async (req, reply) => {
  const id = userOf(req, reply);
  if (!id) return;
  const fill = await broker.place(id, req.body.sym, req.body.side, req.body.pct);
  return { fill, me: broker.me(id) };
});

app.post<{ Body: { sym: string; side: string; lev: number; pct: number } }>("/api/futures/open", {
  schema: { body: { type: "object", required: ["sym", "side", "lev", "pct"], properties: { sym: { type: "string", maxLength: 10 }, side: { type: "string" }, lev: { type: "integer" }, pct: { type: "number" } } } },
}, async (req, reply) => {
  const id = userOf(req, reply);
  if (!id) return;
  const fill = await broker.openFuture(id, req.body.sym, req.body.side, req.body.lev, req.body.pct);
  return { fill, me: broker.me(id) };
});

app.post<{ Body: { posId: number; pct: number } }>("/api/futures/close", {
  schema: { body: { type: "object", required: ["posId", "pct"], properties: { posId: { type: "integer" }, pct: { type: "number" } } } },
}, async (req, reply) => {
  const id = userOf(req, reply);
  if (!id) return;
  const fill = await broker.closeFuture(id, req.body.posId, req.body.pct);
  return { fill, me: broker.me(id) };
});

app.post<{ Body: { posId: number; price: number | null } }>("/api/stop", {
  schema: { body: { type: "object", required: ["posId"], properties: { posId: { type: "integer" }, price: { type: ["number", "null"] } } } },
}, async (req, reply) => {
  const id = userOf(req, reply);
  if (!id) return;
  broker.setStop(id, req.body.posId, req.body.price ?? null);
  return { me: broker.me(id) };
});

app.post<{ Body: { posId: number; price: number | null } }>("/api/tp", {
  schema: { body: { type: "object", required: ["posId"], properties: { posId: { type: "integer" }, price: { type: ["number", "null"] } } } },
}, async (req, reply) => {
  const id = userOf(req, reply);
  if (!id) return;
  broker.setTp(id, req.body.posId, req.body.price ?? null);
  return { me: broker.me(id) };
});

app.post<{ Body: { scope?: "spot" | "futures" | "all" } }>("/api/close-all", {
  schema: { body: { type: "object", properties: { scope: { type: "string", enum: ["spot", "futures", "all"] } } } },
}, async (req, reply) => {
  const id = userOf(req, reply);
  if (!id) return;
  const fills = await broker.closeAll(id, req.body.scope ?? "all");
  return { count: fills.length, fills, me: broker.me(id) };
});

app.post<{ Body: { confirm: boolean } }>("/api/reset", {
  schema: { body: { type: "object", required: ["confirm"], properties: { confirm: { const: true } } } },
}, async (req, reply) => {
  const id = userOf(req, reply);
  if (!id) return;
  broker.reset(id);
  return { me: broker.me(id) };
});

app.get("/api/drawings", async (req, reply) => {
  const id = userOf(req, reply);
  return id && { drawings: broker.getDrawings(id) };
});

app.post<{ Body: { sym?: string; factor?: number; items?: unknown[]; clear?: boolean } }>("/api/drawings", {
  schema: { body: { type: "object", properties: { sym: { type: "string", maxLength: 12 }, factor: { type: "number" }, items: { type: "array" }, clear: { type: "boolean" } } } },
}, async (req, reply) => {
  const id = userOf(req, reply);
  if (!id) return;
  if (req.body.clear) broker.clearDrawings(id);
  else broker.saveDrawing(id, req.body.sym ?? "", req.body.factor ?? 1, req.body.items ?? []);
  return { ok: true };
});

function adminOk(req: FastifyRequest, reply: FastifyReply) {
  if (req.headers["x-admin-key"] === ADMIN_KEY) return true;
  void reply.code(403).send({ error: "운영자 키가 올바르지 않습니다." });
  return false;
}

app.get("/api/chat", async () => ({ messages: chat.recent(50) }));

app.post<{ Body: { text: string } }>("/api/chat", {
  schema: { body: { type: "object", required: ["text"], properties: { text: { type: "string", maxLength: 300 } } } },
}, async (req, reply) => {
  const id = userOf(req, reply);
  if (!id) return;
  const msg = chat.post(id, req.body.text);
  send("chat", msg);
  return { msg };
});

app.post<{ Body: { id: number } }>("/api/chat/report", {
  schema: { body: { type: "object", required: ["id"], properties: { id: { type: "integer" } } } },
}, async (req, reply) => {
  const id = userOf(req, reply);
  if (!id) return;
  const r = chat.report(id, req.body.id);
  if (r.hidden) send("chat-hide", { id: r.id });
  return r;
});

app.get("/api/admin/chat", async (req, reply) => {
  if (!adminOk(req, reply)) return;
  return chat.adminList();
});

app.post<{ Body: { name: string; banned: boolean } }>("/api/admin/ban", {
  schema: { body: { type: "object", required: ["name", "banned"], properties: { name: { type: "string" }, banned: { type: "boolean" } } } },
}, async (req, reply) => {
  if (!adminOk(req, reply)) return;
  chat.setBan(req.body.name, req.body.banned);
  if (req.body.banned) send("chat-purge", { name: req.body.name });
  return { ok: true };
});

app.post<{ Body: { id: number; hidden: boolean } }>("/api/admin/hide", {
  schema: { body: { type: "object", required: ["id", "hidden"], properties: { id: { type: "integer" }, hidden: { type: "boolean" } } } },
}, async (req, reply) => {
  if (!adminOk(req, reply)) return;
  chat.setHidden(req.body.id, req.body.hidden);
  if (req.body.hidden) send("chat-hide", { id: req.body.id });
  return { ok: true };
});

app.post("/api/admin/backup", async (req, reply) => {
  if (!adminOk(req, reply)) return;
  saveSnapshot(db, season, market);
  return { ok: true, file: await backupDb(db, BACKUP_DIR) };
});

// 하루 1회 자동 SQLite 백업 (SPEC 10장)
const backupTimer = setInterval(() => {
  try { saveSnapshot(db, season, market); void backupDb(db, BACKUP_DIR); }
  catch (e) { app.log.error(e); }
}, 24 * 3600 * 1000);
backupTimer.unref();

app.get("/api/stream", (req, reply) => {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  const client: Client = { write: chunk => res.write(chunk) };
  clients.add(client);
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.raw.on("close", () => { clearInterval(ping); clients.delete(client); });
});

app.get("/api/health", async () => ({ ok: true, tick: market.tick, season: season.id, clients: clients.size, bootMs, replayed, fromSnapshot }));

// 프로덕션 정적 파일 서빙: apps/web/dist가 빌드되어 있으면 단일 포트로 화면까지 제공한다 (M7)
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};
if (existsSync(join(WEB_DIST, "index.html"))) {
  const root = resolve(WEB_DIST);
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/") || req.method !== "GET") return reply.code(404).send({ error: "찾을 수 없습니다." });
    const reqPath = req.url.split("?")[0];
    const target = resolve(root, `.${reqPath}`);
    const file = target.startsWith(root) && existsSync(target) && statSync(target).isFile() ? target : join(root, "index.html");
    const ext = extname(file);
    if (file.includes(`${join("dist", "assets")}`)) reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.type(MIME[ext] ?? "application/octet-stream").send(readFileSync(file));
  });
}

const shutdown = async () => { clearInterval(loop); saveSnapshot(db, season, market); await app.close(); db.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: PORT, host: HOST });
app.log.info(`시즌 ${season.id} (seed ${season.seed}) · ${fromSnapshot ? "스냅샷에서" : "처음부터"} ${replayed} tick 재생 · DB ${DB_FILE}`);
