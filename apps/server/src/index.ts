// 도파민 센터 서버: 벽시계 기준 GameLoop + SSE 시세 방송 + 참가·현물·선물 주문.
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SECTORS, type Bar, type NewsItem, type Quote } from "@dopamine/engine";
import { Auth, AuthError } from "./auth.ts";
import { BotRunner } from "./bots.ts";
import { Broker, OrderError } from "./broker.ts";
import { Chat, ChatError } from "./chat.ts";
import { backupDb, openDb } from "./db.ts";
import { bootMarket, currentSeason, endTick, finishSeason, hallOfFame, saveSnapshot, seasonStats, targetTick } from "./season.ts";

const PORT = Number(process.env.PORT ?? 4810);
const HOST = process.env.HOST ?? "127.0.0.1";
const SEED = Number(process.env.SEED ?? 20261021);
const TICK_MS = Number(process.env.TICK_MS ?? 1000);
const SEASON_MS = Number(process.env.SEASON_MS ?? 360 * 80 * TICK_MS); // 시즌 = 게임 1년 (360일 × 80틱, 1초 tick이면 8시간). 진행 중 시즌에도 바로 적용
const SNAPSHOT_EVERY = 600; // tick마다 엔진 스냅샷 저장 (10분)
const DB_FILE = process.env.DB_FILE ?? fileURLToPath(new URL("../../../data/dopamine.db", import.meta.url));
const BACKUP_DIR = process.env.BACKUP_DIR ?? join(dirname(DB_FILE), "backups");
const WEB_DIST = process.env.WEB_DIST ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
// ENGINE_OPTIONS: 테스트용 엔진 설정 덮어쓰기 (JSON). 예: {"splitPrice":1000,"warmupBars":120}
const ENGINE_OPTIONS = JSON.parse(process.env.ENGINE_OPTIONS ?? "{}");
// EXCHANGE_OPTIONS: 테스트용 호가창 설정 덮어쓰기 (JSON). 예: {"backstop":{"stock":0.5,"coin":0.5,"venture":0.6}}
const EXCHANGE_OPTIONS = JSON.parse(process.env.EXCHANGE_OPTIONS ?? "{}");

const db = openDb(DB_FILE);
// 운영자 키. 없거나 짧으면 운영자 기능을 끈다 (기본값을 두면 공개 주소에서 누구나 밴·백업을 할 수 있다)
const ADMIN_KEY = (process.env.ADMIN_KEY ?? "").length >= 16 ? Buffer.from(process.env.ADMIN_KEY!) : null;
const auth = new Auth(db);
const chat = new Chat(db);
// 시즌이 바뀌면 아래 넷을 통째로 갈아 끼운다
const bootStart = performance.now();
let season = currentSeason(db, SEED, TICK_MS, SEASON_MS);
let { market, exchange, warmTicks, replayed, fromSnapshot } = bootMarket(db, season, ENGINE_OPTIONS, Date.now(), EXCHANGE_OPTIONS);
let broker = new Broker(db, season, exchange);
broker.loadAll();
broker.restoreOrders(); // 걸어 둔 지정가를 호가창에 다시 건다
saveSnapshot(db, season, exchange); // 다음 재시작은 여기서부터
const bootMs = Math.round(performance.now() - bootStart);
// 켤 때마다 백업 (시즌이 8시간이라 하루 1회 백업만으로는 부족하다)
backupDb(db, BACKUP_DIR, "boot").catch(e => console.error("백업 실패", e));

// 최근 활동한 사람 (로그인한 요청을 받을 때마다 갱신). 🤖 봇 교대가 "사람 + 봇 = BOTS"를 맞추는 데 쓴다
const lastSeen = new Map<number, number>();
const ACTIVE_MS = 10 * 60_000;
function activeHumans() {
  const now = Date.now();
  let n = 0;
  for (const [id, t] of lastSeen) { if (now - t < ACTIVE_MS) n++; else lastSeen.delete(id); }
  return n;
}

// 🤖 봇·🏦 세력: BOTS=100, MARKET_MAKERS=1로 켠다 (테스트 서버용. 기본은 꺼짐)
const BOTS = Number(process.env.BOTS ?? 0), MARKET_MAKERS = process.env.MARKET_MAKERS === "1";
const bots = BOTS > 0 || MARKET_MAKERS
  ? new BotRunner(db, () => broker, () => exchange, { bots: BOTS, marketMakers: MARKET_MAKERS, seed: SEED, activeHumans, tuning: JSON.parse(process.env.MM_TUNING ?? '{"strength":{}}') })
  : null;

/** 시즌 종료: 백업 → 통계 로그 → 명예의 전당 기록 → 새 시즌 시작 → 모두에게 알림 */
function rollover() {
  const prev = season.id;
  backupDb(db, BACKUP_DIR, `season${prev}-end`).catch(e => app.log.error(e)); // 명예의 전당 기록 전 상태
  app.log.info({ season: prev, ...seasonStats(broker.ranking(Infinity)) }, "시즌 통계");
  season = finishSeason(db, season, broker.ranking(Infinity));
  ({ market, exchange, warmTicks, replayed, fromSnapshot } = bootMarket(db, season, ENGINE_OPTIONS, Date.now(), EXCHANGE_OPTIONS));
  broker = new Broker(db, season, exchange);
  cachedTick = -1;
  saveSnapshot(db, season, exchange);
  app.log.info(`시즌 ${prev} 종료 → 시즌 ${season.id} 시작 (seed ${season.seed})`);
  send("season", seasonInfo());
}
const seasonInfo = () => ({ id: season.id, startedAt: season.startedAt, endsAt: season.startedAt + season.lengthMs });
/** 랭킹(사람 + 🤖) 상위 20명, 참가자 수, 🏦 세력 */
const rankingInfo = (rows = broker.ranking(20)) => ({ rows, players: broker.players, mm: broker.mmRanking(), whales: broker.whaleRanking() });

// JSON 크기를 줄이려고 유효숫자 7자리로 자른다 ($94,880.10, $0.3121 모두 충분)
const r7 = (v: number) => Number(v.toPrecision(7));
const packBar = (b: Bar) => [b.timestamp, r7(b.open), r7(b.high), r7(b.low), r7(b.close), b.volume];
const packQuote = (q: Quote) => ({ ...q, price: r7(q.price), prev: r7(q.prev), per: q.per && r7(q.per), cap: q.cap && Math.round(q.cap) });

// 틱당 1회만 압축 봉·시세를 계산해 SSE 및 /api/poll 요청에서 공유한다
let cachedTick = -1;
let cachedBars: Record<string, number[]> = {};
let cachedQuotes: Quote[] = [];

function ensureTickCache() {
  if (cachedTick === market.tick) return;
  const bars: Record<string, number[]> = {};
  const quotes = exchange.quotes().map(packQuote); // 화면 가격·캔들은 호가창 체결값
  for (const q of quotes) {
    const b = exchange.bars(q.sym).at(-1);
    if (b) bars[q.sym] = [...packBar(b), q.prev];
  }
  cachedQuotes = quotes;
  cachedBars = bars;
  cachedTick = market.tick;
}

function snapshot(viewerName?: string | null) {
  ensureTickCache();
  return { tick: market.tick, date: market.gameDate(), season: seasonInfo(), sectors: SECTORS, quotes: cachedQuotes, news: market.news.slice(0, 50), chat: chat.recent(50, viewerName) };
}

// ---------- SSE ----------
type Client = { write: (chunk: string) => boolean };
const clients = new Set<Client>();
const settledLog: { tick: number; type: string; sym: string }[] = [];
const splitLog: { tick: number; sym: string }[] = [];
let lastAssetsTick = 0;
const send = (event: string, data: unknown) => {
  if (!clients.size) return;
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
    broker.endTick(); // 지난 tick 동안 체결된 순매수를 기준가에 남기고 기록 (재생과 같은 순서)
    const result = exchange.step();
    broker.refundCancelled(result.cancelled); // 병합·폐지로 취소된 지정가 환불
    broker.settleTrades(result.trades); // 가격이 지나간 지정가를 호가 봇이 받은 체결
    if (broker.applyActions(result.actions).length)
      for (const a of result.actions) if (a.type === "split" || a.type === "delist") settled.push({ type: a.type, sym: a.sym });
    broker.runTriggers();
    bots?.tick(result.news);
    news.push(...[...result.news].reverse());
    for (const a of result.actions) if (a.type === "split") reload.push(a.sym);
    assetsChanged ||= result.assetsChanged;
    if (market.tick % SNAPSHOT_EVERY === 0) saveSnapshot(db, season, exchange);
  }
  // 이번 interval에 자동 종료된 포지션(강제 청산·스탑·익절)과 체결된 지정가 종목: 해당 화면이 계좌를 다시 받는다
  const auto = broker.drainAuto();
  settled.push(...auto.closed, ...auto.makers.map(sym => ({ type: "order", sym })));
  ensureTickCache();
  for (const n of news.slice(-50)) send("news", n);
  // 상장 변화: 목록 갱신. 주식병합된 종목은 과거 차트가 바뀌었으니 다시 받으라고 알린다
  if (assetsChanged) {
    lastAssetsTick = market.tick;
    for (const s of reload) splitLog.push({ tick: market.tick, sym: s });
    if (splitLog.length > 200) splitLog.splice(0, splitLog.length - 200);
    send("assets", { quotes: cachedQuotes, reload });
  }
  // 보유 종목이 병합·폐지로 정산됐다: 그 종목을 가진 사람은 계좌를 다시 받는다
  if (settled.length) {
    for (const s of settled) settledLog.push({ tick: market.tick, ...s });
    if (settledLog.length > 200) settledLog.splice(0, settledLog.length - 200);
    send("settled", settled);
  }
  const rankRows = market.tick % 5 === 0 ? broker.ranking(20) : null;
  for (const text of broker.drainBroadcasts()) send("chat", chat.system(text));
  if (!clients.size) return;
  send("tick", { tick: market.tick, date: market.gameDate(), bars: cachedBars });
  if (rankRows) send("ranking", rankingInfo(rankRows));
}, Math.max(10, Math.min(250, TICK_MS / 2)));

// ---------- HTTP ----------
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof AuthError || err instanceof OrderError || err instanceof ChatError) return reply.code(400).send({ error: err.message });
  if ((err as { validation?: unknown }).validation) return reply.code(400).send({ error: "요청 형식이 올바르지 않습니다." });
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  if (status >= 400 && status < 500) return reply.code(status).send({ error: "요청 형식이 올바르지 않습니다." }); // 예: 본문 없는 POST의 Content-Type (415)
  app.log.error(err);
  return reply.code(500).send({ error: "서버 오류가 났습니다." });
});

function userOf(req: FastifyRequest, reply: FastifyReply): number | null {
  const id = auth.userOf(req.headers.authorization);
  if (!id) void reply.code(401).send({ error: "참가가 필요합니다." });
  else lastSeen.set(id, Date.now());
  return id;
}

/**
 * 요청한 사람의 IP. Cloudflare 터널(cloudflared)은 같은 PC에서 접속하므로 모두 127.0.0.1로 보인다.
 * 그때만 cloudflared가 넣는 CF-Connecting-IP를 믿는다. 밖에서 직접 온 요청은 이 헤더를 꾸밀 수 있어 무시한다
 */
function clientIp(req: FastifyRequest): string {
  const peer = req.socket.remoteAddress ?? "";
  const cf = req.headers["cf-connecting-ip"];
  const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  return loopback && typeof cf === "string" && cf ? cf : req.ip;
}

// 참가 시도 속도 제한: IP당 1분에 10번
const joinTries = new Map<string, number[]>();
function joinAllowed(ip: string) {
  const now = Date.now(), recent = (joinTries.get(ip) ?? []).filter(t => now - t < 60_000);
  recent.push(now); joinTries.set(ip, recent);
  return recent.length <= 10;
}

function viewerOf(req: FastifyRequest): string | null {
  const id = auth.userOf(req.headers.authorization);
  if (!id) return null;
  lastSeen.set(id, Date.now()); // 화면 갱신(스냅샷·폴링·채팅 조회)도 활동으로 센다
  return broker.account(id).name;
}

app.get("/api/snapshot", async req => snapshot(viewerOf(req)));

app.get<{ Querystring: { tick?: string } }>("/api/poll", async req => {
  const since = Number(req.query.tick) || market.tick;
  ensureTickCache();
  const settled = settledLog.filter(s => s.tick > since).map(({ type, sym }) => ({ type, sym }));
  const reload = [...new Set(splitLog.filter(s => s.tick > since).map(s => s.sym))];
  return {
    tick: market.tick,
    date: market.gameDate(),
    season: seasonInfo(),
    bars: cachedBars,
    news: market.news.filter(n => n.tick > since).slice(0, 30).reverse(),
    chat: chat.recent(50, viewerOf(req)),
    ranking: rankingInfo(),
    settled: settled.length ? settled : undefined,
    assets: lastAssetsTick > since ? { quotes: cachedQuotes, reload } : undefined,
  };
});

app.get<{ Querystring: { name?: string } }>("/api/portfolio", async req => {
  return broker.portfolioByName(req.query.name ?? "");
});

app.get<{ Querystring: { sym?: string; limit?: string } }>("/api/bars", async (req, reply) => {
  const sym = req.query.sym ?? "";
  if (!exchange.quote(sym)) return reply.code(404).send({ error: "종목을 찾을 수 없습니다." });
  const limit = Math.min(1500, Math.max(1, Number(req.query.limit) || 1500));
  return { sym, bars: exchange.bars(sym).slice(-limit).map(packBar) };
});

app.get<{ Querystring: { before?: string; limit?: string } }>("/api/news", async req => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const before = Number(req.query.before) || Infinity;
  return { news: market.news.filter(n => n.tick < before).slice(0, limit) };
});

app.get("/api/hall", async () => ({ rows: hallOfFame(db) }));

app.get("/api/ranking", async () => rankingInfo());

app.post<{ Body: { name: string; password: string } }>("/api/join", {
  schema: { body: { type: "object", required: ["name", "password"], properties: { name: { type: "string", maxLength: 40 }, password: { type: "string", maxLength: 64 } } } },
}, async (req, reply) => {
  if (!joinAllowed(clientIp(req))) return reply.code(429).send({ error: "참가 시도가 너무 많습니다. 1분 뒤에 다시 시도하세요." });
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

// 지정가: 맞는 호가가 있으면 그만큼 바로 체결되고, 남은 수량은 호가창에 걸린다. kind spot = 현물, fut = 선물 진입 (buy 롱, sell 숏)
app.post<{ Body: { sym: string; kind: "spot" | "fut"; side: "buy" | "sell"; price: number; pct: number; lev?: number } }>("/api/limit", {
  schema: { body: { type: "object", required: ["sym", "kind", "side", "price", "pct"], properties: { sym: { type: "string", maxLength: 10 }, kind: { type: "string", enum: ["spot", "fut"] }, side: { type: "string", enum: ["buy", "sell"] }, price: { type: "number" }, pct: { type: "number" }, lev: { type: "integer" } } } },
}, async (req, reply) => {
  const id = userOf(req, reply);
  if (!id) return;
  const r = broker.limitOrder(id, req.body);
  return { ...r, me: broker.me(id) };
});

app.post<{ Body: { id?: number; all?: boolean } }>("/api/cancel", {
  schema: { body: { type: "object", properties: { id: { type: "integer" }, all: { type: "boolean" } } } },
}, async (req, reply) => {
  const id = userOf(req, reply);
  if (!id) return;
  const count = req.body.all ? broker.cancelAll(id) : (broker.cancelOrder(id, req.body.id ?? -1), 1);
  return { count, me: broker.me(id) };
});

// 호가창: 보고 있는 종목만 1초마다 받는다. 매도·매수 각 10단계 + 최근 체결
app.get<{ Querystring: { sym?: string } }>("/api/book", async (req, reply) => {
  const b = exchange.book(req.query.sym ?? "", 10);
  if (!b) return reply.code(404).send({ error: "종목을 찾을 수 없습니다." });
  const lv = (l: { price: number; qty: number }) => [r7(l.price), r7(l.qty)];
  return { sym: b.sym, tick: market.tick, tickSize: b.tickSize, asks: b.asks.map(lv), bids: b.bids.map(lv), trades: b.trades.slice(0, 20).map(t => [r7(t.price), r7(t.qty), t.side === "buy" ? 1 : -1, t.at]) };
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
  const given = Buffer.from(String(req.headers["x-admin-key"] ?? ""));
  if (ADMIN_KEY && given.length === ADMIN_KEY.length && timingSafeEqual(given, ADMIN_KEY)) return true;
  void reply.code(403).send({ error: ADMIN_KEY ? "운영자 키가 올바르지 않습니다." : "운영자 키(ADMIN_KEY)가 설정되지 않아 운영자 기능이 꺼져 있습니다." });
  return false;
}

app.get("/api/chat", async req => ({ messages: chat.recent(50, viewerOf(req)) }));

app.post<{ Body: { text: string } }>("/api/chat", {
  schema: { body: { type: "object", required: ["text"], properties: { text: { type: "string", maxLength: 300 } } } },
}, async (req, reply) => {
  const id = userOf(req, reply);
  if (!id) return;
  const msg = chat.post(id, req.body.text);
  // SSE는 누구나 받으니 귓속말 내용은 싣지 않는다. 신호만 보내면 로그인한 화면이 /api/chat(본인 것만 걸러 줌)으로 받아 간다
  if (msg.to) send("whisper", {});
  else send("chat", msg);
  return { msg };
});

// 강제청산 알림에 티배깅·묵념: 알림 1건당 처음 누른 한 명만. 성공하면 모두의 화면에서 버튼이 사라진다
app.post<{ Body: { liqId: number; mode: "teabag" | "rip" } }>("/api/chat/react", {
  schema: { body: { type: "object", required: ["liqId", "mode"], properties: { liqId: { type: "integer" }, mode: { type: "string", enum: ["teabag", "rip"] } } } },
}, async (req, reply) => {
  const id = userOf(req, reply);
  if (!id) return;
  const msg = chat.react(id, req.body.liqId, req.body.mode);
  send("chat", msg);
  send("chat-react", { id: req.body.liqId });
  return { msg };
});

// "[공유]" 수익인증: 문구는 서버가 실제 계좌 값으로 만든다
app.post<{ Body: { type: "spot" | "fut" | "fill" | "summary"; sym?: string; id?: number } }>("/api/chat/share", {
  schema: { body: { type: "object", required: ["type"], properties: { type: { type: "string", enum: ["spot", "fut", "fill", "summary"] }, sym: { type: "string", maxLength: 12 }, id: { type: "integer" } } } },
}, async (req, reply) => {
  const id = userOf(req, reply);
  if (!id) return;
  const msg = chat.post(id, broker.shareText(id, req.body), Date.now(), true);
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
  saveSnapshot(db, season, exchange);
  return { ok: true, file: await backupDb(db, BACKUP_DIR) };
});

// 지금 시즌을 끝내고 새 시즌을 연다 (명예의 전당 기록·백업 포함). 엔진·호가창 규칙을 바꿔 배포한 직후에 쓴다: 시즌 중간에 규칙이 바뀌면 재생이 어긋난다
app.post("/api/admin/new-season", async (req, reply) => {
  if (!adminOk(req, reply)) return;
  const ended = season.id;
  rollover();
  return { ok: true, ended, season: season.id };
});

// 하루 1회 자동 SQLite 백업 (SPEC 10장)
const backupTimer = setInterval(() => {
  try { saveSnapshot(db, season, exchange); backupDb(db, BACKUP_DIR).catch(e => app.log.error(e)); }
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
const staticCache = new Map<string, { mtimeMs: number; buf: Buffer; mime: string; immutable: boolean }>();
if (existsSync(join(WEB_DIST, "index.html"))) {
  const root = resolve(WEB_DIST);
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/") || req.method !== "GET") return reply.code(404).send({ error: "찾을 수 없습니다." });
    const reqPath = req.url.split("?")[0];
    const target = resolve(root, `.${reqPath}`);
    const file = (target === root || target.startsWith(root + sep)) && existsSync(target) && statSync(target).isFile() ? target : join(root, "index.html");
    const st = statSync(file);
    let hit = staticCache.get(file);
    if (!hit || hit.mtimeMs !== st.mtimeMs) {
      const ext = extname(file);
      hit = {
        mtimeMs: st.mtimeMs,
        buf: readFileSync(file),
        mime: MIME[ext] ?? "application/octet-stream",
        immutable: file.includes(`${join("dist", "assets")}`),
      };
      staticCache.set(file, hit);
    }
    if (hit.immutable) reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.type(hit.mime).send(hit.buf);
  });
}

const shutdown = async () => { clearInterval(loop); saveSnapshot(db, season, exchange); await app.close(); db.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: PORT, host: HOST });
app.log.info(`시즌 ${season.id} (seed ${season.seed}) · ${fromSnapshot ? "스냅샷에서" : "처음부터"} ${replayed} tick 재생 · DB ${DB_FILE}`);
