import assert from "node:assert/strict";
import { test } from "node:test";
import { Auth, AuthError } from "../src/auth.ts";
import { Broker, GOAL, OrderError, START_CASH, liqPrice } from "../src/broker.ts";
import { BotRunner } from "../src/bots.ts";
import { Chat, ChatError } from "../src/chat.ts";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { backupDb, openDb } from "../src/db.ts";
import { badgesOf, bootMarket, currentSeason, finishSeason, hallOfFame, saveSnapshot, setTop3Message, touchSeason } from "../src/season.ts";

const T0 = 1_792_000_000_000;
const FAST = { ticksPerBar: 10, warmupBars: 200 };

function setup(seed = 1) {
  const db = openDb(":memory:");
  const season = currentSeason(db, seed, 1000, 7 * 86_400_000, T0);
  const { market, exchange } = bootMarket(db, season, FAST, T0);
  const broker = new Broker(db, season, exchange);
  const auth = new Auth(db);
  /** 한 tick (서버 루프와 같은 순서): 순매수 기록 → 엔진·호가창 → 취소 환불 → 상장 변화 정산 → 청산·스탑 */
  const tick = () => { broker.endTick(); const r = exchange.step(); broker.refundCancelled(r.cancelled); broker.settleTrades(r.trades); broker.applyActions(r.actions); broker.runTriggers(); return r; };
  // 서버처럼 참가하면 계좌가 생긴다
  const user = (name: string) => { const id = auth.join(name, "secret1").userId; broker.me(id); return id; };
  return { db, season, market, exchange, broker, auth, tick, user };
}
/** 주문 (호가창에서 바로 체결) 뒤 한 tick */
async function order(s: ReturnType<typeof setup>, userId: number, sym: string, side: string, pct: number) {
  const p = s.broker.place(userId, sym, side, pct);
  s.tick();
  return p; }
async function openFut(s: ReturnType<typeof setup>, userId: number, sym: string, side: string, lev: number, pct: number) {
  const p = s.broker.openFuture(userId, sym, side, lev, pct);
  s.tick();
  return p;
}
async function closeFut(s: ReturnType<typeof setup>, userId: number, posId: number, pct: number) {
  const p = s.broker.closeFuture(userId, posId, pct);
  s.tick();
  return p;
}

test("참가: 새 이름은 가입, 같은 이름은 비밀번호 확인 (대소문자 무시)", () => {
  const { auth } = setup();
  const a = auth.join("Ant", "secret1");
  assert.ok(a.created);
  const b = auth.join("ant", "secret1");
  assert.equal(b.userId, a.userId);
  assert.equal(b.created, false);
  assert.throws(() => auth.join("ANT", "wrong-pw"), AuthError);
  assert.throws(() => auth.join("a", "secret1"), AuthError, "이름 2자 이상");
  assert.throws(() => auth.join("이름에 공백", "secret1"), AuthError);
  assert.throws(() => auth.join("short", "12345"), AuthError, "비밀번호 6자 이상");
  assert.equal(auth.userOf(`Bearer ${a.token}`), a.userId);
  assert.equal(auth.userOf("Bearer nope"), null);
});

test("매수: 예수금 비중, 정수 주, 수수료 포함 평단, 호가를 먹으며 바로 체결", async () => {
  const s = setup();
  const u = s.user("buyer");
  const ask = s.exchange.best("NVDA").ask!;
  const fill = await s.broker.place(u, "NVDA", "buy", 50);
  assert.ok(Number.isInteger(fill.qty) && fill.qty > 0);
  assert.ok(fill.price >= ask - 1e-9, "평균 체결가 ≥ 최우선 매도호가");
  assert.ok(s.exchange.price("NVDA") >= ask, "체결가가 화면 가격");
  assert.ok(fill.qty * fill.price + fill.fee <= START_CASH * 0.5 + 1e-6, "예산 안");
  assert.ok(Math.abs(fill.fee - fill.qty * fill.price * 0.0005) < 1e-9);
  const me = s.broker.me(u);
  assert.ok(Math.abs(me.cash - (START_CASH - fill.qty * fill.price - fill.fee)) < 1e-6);
  assert.ok(Math.abs(me.positions[0].avg - (fill.qty * fill.price + fill.fee) / fill.qty) < 1e-9, "평단에 수수료 포함");
});

test("매도: 보유 비중, 전량 매도하면 보유종목에서 사라진다", async () => {
  const s = setup();
  const u = s.user("seller");
  await order(s, u, "AAPL", "buy", 40);
  const held = s.broker.me(u).positions[0].qty;
  const half = await order(s, u, "AAPL", "sell", 50);
  assert.equal(half.qty, Math.floor(held / 2));
  const rest = await order(s, u, "AAPL", "sell", 100);
  assert.equal(rest.qty, held - half.qty);
  assert.equal(s.broker.me(u).positions.length, 0);
  assert.equal(s.broker.me(u).positions.length, 0);
  assert.equal(s.broker.me(u).fills.length, 3);
  assert.throws(() => s.broker.place(u, "AAPL", "sell", 10), OrderError, "보유 없음은 바로 거절");
});

test("코인은 소수 수량으로 살 수 있다", async () => {
  const s = setup();
  const u = s.user("coiner");
  const fill = await order(s, u, "BTC", "buy", 10);
  assert.ok(fill.qty > 0 && fill.qty < 1, `BTC ${fill.qty}`);
});

test("같은 1초 안에서도 먼저 산 사람이 싸게 산다, 사고 바로 팔면 스프레드만큼 손해", async () => {
  const s = setup();
  const a = s.user("alpha"), b = s.user("bravo");
  // 호가가 얇은 신흥주: $3만이면 여러 단계를 먹는다
  const fa = await s.broker.place(a, "LMQ", "buy", 30), fb = await s.broker.place(b, "LMQ", "buy", 30);
  assert.ok(fb.price > fa.price, "뒤에 산 사람이 더 비싸게");
  const sell = await s.broker.place(a, "LMQ", "sell", 100);
  assert.ok(sell.price < fb.price, "파는 쪽은 매수호가");
});

test("지정가: 걸어 두면 돈이 묶이고, 다른 사람의 시장가에 체결되면 수수료 없이 보유가 생긴다, 취소하면 풀린다", async () => {
  const s = setup();
  const maker = s.user("maker"), taker = s.user("taker");
  const bid = s.exchange.best("AAPL").bid!, tick = s.exchange.tickOf("AAPL");
  const res = s.broker.limitOrder(maker, { sym: "AAPL", kind: "spot", side: "buy", price: bid + tick, pct: 10 });
  assert.ok(res.order && !res.fills.length, "최우선 매수호가보다 한 칸 위에 걸림");
  const locked = START_CASH - s.broker.me(maker).cash;
  assert.ok(locked > 9_000 && locked <= 10_000 + 1e-6, "예수금 10% 묶임");
  assert.ok(Math.abs(s.broker.me(maker).equity - START_CASH) < 1e-6, "묶인 돈도 총자산에 포함");
  await order(s, taker, "AAPL", "buy", 20);
  await order(s, taker, "AAPL", "sell", 100); // 최우선 매수호가 = maker 주문 → maker 체결
  const me = s.broker.me(maker);
  assert.ok(me.positions[0]?.qty > 0, "지정가 체결로 보유");
  assert.equal(me.fills.find(f => f.side === "buy")!.fee, 0, "지정가 체결 수수료 0");
  if (me.orders.length) {
    s.broker.cancelOrder(maker, me.orders[0].id);
    assert.equal(s.broker.me(maker).orders.length, 0);
  }
  const after = s.broker.me(maker);
  assert.ok(Math.abs(after.cash + after.positions[0].qty * after.positions[0].avg - START_CASH) < 1e-6, "남은 묶음은 돌려받음");
  assert.equal(s.db.prepare("SELECT COUNT(*) AS c FROM open_orders").get()!.c, 0);
});

test("지정가 전체 취소, 가격이 지나간 지정가는 tick에 호가 봇이 받아 체결된다", async () => {
  const s = setup(5);
  const u = s.user("lister");
  const bid = s.exchange.best("MSFT").bid!;
  s.broker.limitOrder(u, { sym: "MSFT", kind: "spot", side: "buy", price: bid * 0.95, pct: 10 });
  s.tick();
  s.broker.limitOrder(u, { sym: "MSFT", kind: "fut", side: "sell", lev: 2, price: bid * 1.05, pct: 10 });
  s.tick();
  assert.equal(s.broker.me(u).orders.length, 2);
  assert.equal(s.broker.cancelAll(u), 2);
  assert.equal(s.broker.me(u).orders.length, 0);
  assert.ok(Math.abs(s.broker.me(u).cash - START_CASH) < 1e-6, "묶인 돈 모두 풀림");
  assert.throws(() => s.broker.cancelAll(u), OrderError);
  // 재시작 등으로 기준가보다 훨씬 비싼 매수 지정가가 남아 있으면 다음 tick에 그 가격으로 체결된다
  s.tick();
  const { order: o } = s.broker.limitOrder(u, { sym: "MSFT", kind: "spot", side: "buy", price: bid * 0.99, pct: 10 });
  const [resting] = s.exchange.openOrders(u);
  assert.ok(o && resting);
  s.exchange.cancel(u, o!.id);
  s.exchange.restoreOrder({ ...resting, price: bid * 1.03 }); // 기준가가 지정가를 지나간 상황을 만들려고 호가창의 가격만 올린다
  s.tick();
  const me = s.broker.me(u);
  assert.equal(me.orders.length, 0, "체결돼 미체결에서 사라짐");
  const f = me.fills.find(x => x.side === "buy")!;
  assert.ok(Math.abs(f.price - bid * 1.03) / f.price < 0.001 && f.fee === 0, "그 지정가에 수수료 없이");
});

test("지정가는 재시작해도 호가창에 다시 걸린다", () => {
  const s = setup(4);
  const u = s.user("resting");
  const bid = s.exchange.best("NVDA").bid!;
  const { order: o } = s.broker.limitOrder(u, { sym: "NVDA", kind: "fut", side: "buy", lev: 3, price: bid * 0.98, pct: 20 });
  const { exchange } = bootMarket(s.db, s.season, FAST, T0);
  const b2 = new Broker(s.db, s.season, exchange);
  b2.restoreOrders();
  assert.deepEqual(exchange.openOrders(u).map(x => x.id), [o!.id]);
  assert.equal(b2.me(u).orders.length, 1);
  assert.ok(Math.abs(b2.me(u).equity - START_CASH) < 1e-6);
});

test("잘못된 주문과 너무 빠른 주문은 거절된다", () => {
  const s = setup();
  const u = s.user("rusher");
  assert.throws(() => s.broker.place(u, "NOPE", "buy", 10), OrderError);
  assert.throws(() => s.broker.place(u, "NVDA", "hold", 10), OrderError);
  assert.throws(() => s.broker.place(u, "NVDA", "buy", 0), OrderError);
  assert.throws(() => s.broker.place(u, "NVDA", "buy", 101), OrderError);
  void s.broker.place(u, "NVDA", "buy", 1);
  void s.broker.place(u, "NVDA", "buy", 1);
  assert.throws(() => s.broker.place(u, "NVDA", "buy", 1), OrderError, "초당 2건");
  s.tick();
});

test("종목당 보유 한도: 가상 유동성의 20%", async () => {
  const s = setup();
  const u = s.user("whale");
  const venture = s.market.quotes().filter(q => q.market === "venture").sort((x, y) => (x.cap ?? 0) - (y.cap ?? 0))[0].sym;
  const limit = 0.2 * s.market.liquidity(venture)!;
  const fill = await order(s, u, venture, "buy", 100);
  assert.ok(fill.qty * fill.price <= limit * 1.0001, `한도 $${limit.toFixed(0)} 이하`);
  if (fill.qty * fill.price > limit * 0.9) await assert.rejects(order(s, u, venture, "buy", 100), OrderError);
});

test("주식병합 정산: 수량 ÷ratio, 평단 ×ratio, 단주는 현금", async () => {
  const s = setup();
  const u = s.user("holder");
  await order(s, u, "LMQ", "buy", 5);
  const before = s.broker.me(u).positions[0];
  const cash = s.broker.me(u).cash;
  const price = s.exchange.price("LMQ");
  s.broker.applyActions([{ type: "split", sym: "LMQ", ratio: 10 }]);
  const after = s.broker.me(u);
  const pos = after.positions.find(p => p.sym === "LMQ");
  const whole = Math.floor(before.qty / 10), fraction = before.qty / 10 - whole;
  assert.equal(pos?.qty ?? 0, whole);
  if (pos) assert.ok(Math.abs(pos.avg - before.avg * 10) < 1e-9);
  assert.ok(Math.abs(after.cash - (cash + fraction * price)) < 1e-6, "단주 현금 지급");
});

test("상장폐지 정산: 마지막 가격으로 전량 현금화", async () => {
  const s = setup();
  const u = s.user("unlucky");
  await order(s, u, "SKPT", "buy", 10);
  const qty = s.broker.me(u).positions[0].qty, cash = s.broker.me(u).cash;
  s.broker.applyActions([{ type: "delist", sym: "SKPT", price: 0.5 }]);
  const me = s.broker.me(u);
  assert.equal(me.positions.length, 0);
  assert.ok(Math.abs(me.cash - (cash + qty * 0.5)) < 1e-9);
  assert.equal(me.fills[0].side, "delist");
});

test("랭킹: 총자산 순, 다시 시작하면 $100,000", async () => {
  const s = setup();
  const a = s.user("rich"), b = s.user("calm");
  await order(s, a, "TSLA", "buy", 100);
  const rows = s.broker.ranking();
  assert.equal(rows.length, 2);
  assert.ok(rows[0].equity >= rows[1].equity);
  assert.equal(rows.find(r => r.name === "calm")!.equity, START_CASH);
  s.broker.reset(a);
  assert.equal(s.broker.me(a).equity, START_CASH);
  assert.equal(s.broker.me(a).positions.length, 0);
  assert.ok(GOAL === 100 * START_CASH);
});

test("서버를 다시 켜면 기록된 주문 흐름으로 같은 시세가 재생된다", async () => {
  const s = setup(7);
  const u = s.user("replayer");
  const plan: Record<number, [string, string]> = { 0: ["LMQ", "buy"], 5: ["NVDA", "buy"], 10: ["LMQ", "sell"], 15: ["NVDA", "buy"], 20: ["NVDA", "sell"] };
  for (let i = 0; i < 30; i++) {
    if (plan[i]) void s.broker.place(u, plan[i][0], plan[i][1], 30);
    s.tick();
  }
  for (let i = 0; i < 200; i++) s.tick();
  const live = s.market.quotes();
  const elapsed = s.market.tick - 2000; // warmup = 200봉 × 10틱
  const { market: replayed, replayed: n } = bootMarket(s.db, s.season, FAST, T0 + elapsed * 1000);
  assert.equal(n, elapsed);
  assert.deepEqual(replayed.quotes(), live);
});

test("스냅샷 + 이후 주문 흐름으로 복원해도 같은 시세", async () => {
  const s = setup(9);
  const u = s.user("snapper");
  await order(s, u, "NVDA", "buy", 30);
  for (let i = 0; i < 100; i++) s.tick();
  saveSnapshot(s.db, s.season, s.exchange);
  await order(s, u, "LMQ", "buy", 20);
  for (let i = 0; i < 100; i++) s.tick();
  const elapsed = s.market.tick - 2000;
  const boot = bootMarket(s.db, s.season, FAST, T0 + elapsed * 1000);
  assert.ok(boot.fromSnapshot);
  assert.ok(boot.replayed < elapsed, `스냅샷 뒤 ${boot.replayed} tick만 재생`);
  assert.deepEqual(boot.market.quotes(), s.market.quotes());
});

test("서버가 꺼져 있던 동안은 시세가 멈춘다: 켜면 꺼져 있던 시간만큼 시즌 시작·종료를 미루고 마지막 tick에서 이어진다", () => {
  const s = setup(11);
  for (let i = 0; i < 50; i++) s.tick();
  const lastSeen = T0 + (s.market.tick - 2000) * 1000 + 300; // 마지막 tick 시각 (tick 사이 어딘가)
  touchSeason(s.db, s.season, lastSeen);
  saveSnapshot(s.db, s.season, s.exchange);
  const off = 3 * 3600_000; // 3시간 꺼짐
  const later = currentSeason(s.db, 1, 1000, 7 * 86_400_000, lastSeen + off);
  assert.equal(later.id, s.season.id, "시즌 그대로");
  assert.equal(later.startedAt, T0 + off, "시즌 시작(과 종료)이 꺼져 있던 시간만큼 밀린다");
  const boot = bootMarket(s.db, later, FAST, lastSeen + off);
  assert.equal(boot.replayed, 0, "꺼져 있던 동안의 시세는 만들지 않는다");
  assert.deepEqual(boot.market.quotes(), s.market.quotes());
  assert.equal(currentSeason(s.db, 1, 1000, 7 * 86_400_000, lastSeen + off + 500).startedAt, T0 + off, "1 tick 안의 재시작은 그대로");
});

test("매일 일정: 00:00 시작·23:58 종료, 끝나면 다음 00:00까지 쉬고, 꺼져 있던 동안 멈춰도 종료 시각은 그대로", () => {
  const at = (h: number, m = 0, day = 23) => new Date(2026, 9, day, h, m).getTime();
  const db = openDb(":memory:");
  // 낮에 처음 열면 지금부터 오늘 23:58까지
  const s1 = currentSeason(db, 1, 1000, null, at(19, 30));
  assert.equal(s1.startedAt, at(19, 30));
  assert.equal(s1.startedAt + s1.lengthMs, at(23, 58));
  // 1시간 꺼졌다 켜면 시작은 밀리고 종료는 그대로
  touchSeason(db, s1, at(20));
  const back = currentSeason(db, 1, 1000, null, at(21));
  assert.equal(back.startedAt, at(20, 30));
  assert.equal(back.startedAt + back.lengthMs, at(23, 58));
  // 23:58에 끝나면 다음 시즌은 00:00부터 23:58까지
  const s2 = finishSeason(db, back, [], at(23, 58), null);
  assert.equal(s2.startedAt, at(0, 0, 24));
  assert.equal(s2.startedAt + s2.lengthMs, at(23, 58, 24));
});

test("엔진이 바뀌어 스냅샷을 못 읽어도 시즌은 이어진다: 처음부터 재생해 지금 tick까지", () => {
  const s = setup(10);
  for (let i = 0; i < 50; i++) s.tick();
  saveSnapshot(s.db, s.season, s.exchange);
  s.db.prepare("UPDATE snapshots SET data = ? WHERE season_id = ?").run('{"v":999}', s.season.id); // 읽을 수 없는 스냅샷
  const elapsed = s.market.tick - 2000;
  const boot = bootMarket(s.db, s.season, FAST, T0 + elapsed * 1000);
  assert.equal(boot.fromSnapshot, false);
  assert.equal(boot.market.tick, s.market.tick, "지금 시각까지 재생");
  assert.equal(currentSeason(s.db, 1, 1000, 7 * 86_400_000, T0).id, s.season.id, "시즌 그대로");
});

test("졸업(20배)·전설(100배) 알림, 시즌 종료: 명예의 전당은 전설만, 새 시즌은 새 seed와 $100,000 계좌", async () => {
  const s = setup(10);
  const a = s.user("winner"), b = s.user("legend"), c = s.user("grad"), d = s.user("fourth");
  await order(s, a, "NVDA", "buy", 50);
  void d;
  s.broker.account(b).cash = 11_000_000; // 100배 넘김 → 졸업 + 전설
  s.broker.account(c).cash = 3_000_000;  // 20배 넘김 → 졸업만
  s.tick();
  const rows = s.broker.ranking(Infinity);
  const casts = s.broker.drainBroadcasts();
  assert.ok(casts.some(t => t.startsWith("[전설]") && t.includes("legend")), "전설 알림");
  assert.ok(casts.some(t => t.startsWith("[졸업]") && t.includes("grad")), "졸업 알림");
  assert.equal(rows.find(r => r.name === "grad")?.gradTick != null && rows.find(r => r.name === "grad")?.clearedTick, null, "20배는 졸업만");
  const next = finishSeason(s.db, s.season, rows, T0 + s.season.lengthMs + 1000);
  assert.equal(next.id, s.season.id + 1);
  assert.notEqual(next.seed, s.season.seed);
  assert.equal(next.startedAt, T0 + s.season.lengthMs, "이전 시즌이 끝난 시각에 이어서 시작");
  const { seasons, rows: hall } = hallOfFame(s.db);
  assert.deepEqual(hall.map(h => h.name), ["legend"], "명예의 전당은 100배 전설만 (1위 자동 등재 없음)");
  assert.deepEqual(seasons, [s.season.id], "끝난 시즌 번호 (시즌 탭)");
  assert.equal(currentSeason(s.db, 1, 1000, 1, T0).id, next.id, "진행 중 시즌 = 새 시즌");
  const { exchange } = bootMarket(s.db, next, FAST, next.startedAt);
  const broker = new Broker(s.db, next, exchange);
  assert.equal(broker.me(a).equity, START_CASH);
  assert.equal(broker.me(a).positions.length, 0);
});

test("시즌 TOP 3(사람 최종 순위)는 메달과 한마디, 전설은 시즌 엠블럼 (진행 중 시즌은 달성하는 순간부터)", async () => {
  const s = setup(11);
  const a = s.user("first"), b = s.user("second"), c = s.user("third"), d = s.user("fourth");
  s.broker.account(a).cash = 11_000_000; s.broker.account(b).cash = 900_000; s.broker.account(c).cash = 500_000; void d;
  s.tick();
  const rows = s.broker.ranking(Infinity);
  let badges = badgesOf(s.db, s.season.id);
  assert.deepEqual(badges.first?.emblems.map(e => e.icon), ["🔥"], "S1 전설은 🔥, 시즌 중에도 바로");
  finishSeason(s.db, s.season, rows, T0 + s.season.lengthMs + 1000);
  const hall = hallOfFame(s.db);
  assert.deepEqual(hall.top3.map(t => [t.rank, t.name]), [[1, "first"], [2, "second"], [3, "third"]], "TOP 3는 전설이 아니어도");
  badges = badgesOf(s.db, s.season.id + 1);
  assert.deepEqual(badges.second?.medals, [{ season: s.season.id, rank: 2 }]);
  assert.ok(setTop3Message(s.db, s.season.id, "SECOND", "다음 시즌도 간다"), "본인(대소문자 무시)");
  assert.equal(hallOfFame(s.db).top3[1].message, "다음 시즌도 간다");
  assert.equal(setTop3Message(s.db, s.season.id, "fourth", "나도"), false, "TOP 3가 아니면 못 남김");
});

test("다시 시작하면 체결 내역·실현손익은 그 뒤부터 (기록은 DB에 남는다)", async () => {
  const s = setup();
  const u = s.user("restart");
  await order(s, u, "NVDA", "buy", 20);
  await order(s, u, "NVDA", "sell", 100);
  assert.equal(s.broker.me(u).fills.length, 2);
  s.tick();
  s.broker.reset(u);
  assert.equal(s.broker.me(u).fills.length, 0, "리셋 뒤 빈 체결 내역");
  await order(s, u, "AAPL", "buy", 10);
  assert.deepEqual(s.broker.me(u).fills.map(f => f.sym), ["AAPL"]);
  assert.equal((s.db.prepare("SELECT COUNT(*) AS c FROM fills WHERE user_id = ?").get(u) as { c: number }).c, 3, "DB 기록은 그대로");
});


test("선물 진입·분할 종료·전량 종료: 격리 증거금, 수수료, 스탑로스 유지", async () => {
  const s = setup();
  const u = s.user("fut_trader");
  const open = await openFut(s, u, "NVDA", "long", 5, 20);
  assert.equal(open.side, "long-open");
  const me1 = s.broker.me(u);
  assert.equal(me1.futures.length, 1);
  const f = me1.futures[0];
  const expectedMargin = (START_CASH * 0.2) / (1 + 5 * 0.0005);
  const oneShare = f.entry / 5; // 1주 단위로 내림하므로 1주 증거금만큼 덜 쓸 수 있다
  assert.ok(Number.isInteger(f.qty) && f.margin <= expectedMargin + 1e-6 && f.margin > expectedMargin - oneShare, "예산 안에 진입 수수료 포함, 1주 단위");
  assert.ok(Math.abs(me1.cash - (START_CASH - f.margin - f.qty * f.entry * 0.0005)) < 1e-6);
  assert.ok(Math.abs(f.liq - liqPrice(f)) < 1e-9);

  // 스탑로스 설정 후 50% 분할 종료해도 스탑로스는 남은 포지션에 유지
  const stop = f.entry * 0.9;
  s.broker.setStop(u, f.id, stop);
  const half = await closeFut(s, u, f.id, 50);
  assert.equal(half.side, "long-close");
  const me2 = s.broker.me(u);
  assert.equal(me2.futures.length, 1);
  assert.ok(Math.abs(me2.futures[0].qty - f.qty / 2) < 1e-9);
  assert.ok(Math.abs(me2.futures[0].margin - f.margin / 2) < 1e-9);
  assert.equal(me2.futures[0].stop, stop);

  // 전량 종료하면 포지션 삭제
  await closeFut(s, u, f.id, 100);
  assert.equal(s.broker.me(u).futures.length, 0);
});

test("같은 종목·방향·배율 선물은 하나로 합친다 (물타기): 수량·증거금 합, 진입가 가중 평균, 손절 유지. 배율이 다르면 따로", async () => {
  const s = setup(3);
  const u = s.user("water");
  const f1 = await openFut(s, u, "AAPL", "long", 2, 10);
  s.broker.setStop(u, s.broker.me(u).futures[0].id, f1.price * 0.9);
  const f2 = await openFut(s, u, "AAPL", "long", 2, 10);
  let fs = s.broker.me(u).futures;
  assert.equal(fs.length, 1, "하나로 합침");
  const want = (f1.qty * f1.price + f2.qty * f2.price) / (f1.qty + f2.qty);
  assert.ok(Math.abs(fs[0].qty - (f1.qty + f2.qty)) < 1e-9 && Math.abs(fs[0].entry / want - 1) < 1e-9, "수량 합·가중 평균 진입가");
  assert.ok(fs[0].stop != null, "손절 유지");
  await openFut(s, u, "AAPL", "long", 5, 10);
  await openFut(s, u, "AAPL", "short", 2, 10);
  fs = s.broker.me(u).futures;
  assert.equal(fs.length, 3, "배율·방향이 다르면 따로");
  // 예전 DB처럼 같은 키 포지션이 둘이면 서버를 켤 때 합친다
  const id = fs.find(f => f.lev === 5)!.id;
  s.db.prepare("INSERT INTO futures (user_id, season_id, sym, side, lev, qty, entry, margin, stop, tp, opened_tick) SELECT user_id, season_id, sym, side, lev, qty, entry * 1.1, margin, NULL, NULL, opened_tick FROM futures WHERE id = ?").run(id);
  const b2 = new Broker(s.db, s.season, s.exchange);
  assert.equal(b2.me(u).futures.length, 3, "불러올 때 합침");
  assert.equal((s.db.prepare("SELECT COUNT(*) AS c FROM futures WHERE user_id = ?").get(u) as { c: number }).c, 3, "DB에서도 합침");
});

test("선물 레버리지 한도 및 다시 시작 후 10분간 5배 초과 금지", async () => {
  const s = setup();
  const u = s.user("lev_tester");
  assert.throws(() => s.broker.openFuture(u, "BTC", "long", 20, 10), OrderError, "코인은 최대 10배");
  assert.throws(() => s.broker.openFuture(u, "LMQ", "short", 4, 10), OrderError, "선택지(2·3·5·10)에 없는 배율");
  await openFut(s, u, "NVDA", "short", 10, 10);
  s.broker.reset(u);
  assert.equal(s.broker.me(u).futures.length, 0);
  assert.throws(() => s.broker.openFuture(u, "NVDA", "long", 10, 10), OrderError, "리셋 직후 10배 금지");
  await openFut(s, u, "NVDA", "long", 5, 10);
  for (let i = 0; i < 600; i++) s.tick();
  await openFut(s, u, "NVDA", "long", 10, 10);
  assert.ok(s.broker.me(u).futures.some(f => f.lev === 10), "10분 뒤에는 10배 가능"); // 앞의 5배 롱은 그사이 악재로 청산될 수도 있다
});

test("강제 청산: 증거금 90% 손실 가격이 되면 바로 시장가 강제 청산", async () => {
  const s = setup();
  const u = s.user("degen");
  await openFut(s, u, "LMQ", "long", 5, 50); // 청산가 = 진입가 × (1 - 0.9/5) = 0.82
  const f = s.broker.me(u).futures[0];
  while (s.market.quote("LMQ")!.price > f.liq * 0.98) s.market.absorbFlow("LMQ", -1e9);
  s.tick(); // 호가 봇이 밀린 기준가로 다시 깔면 체결가가 청산가를 넘고, 바로 시장가 강제 청산
  const auto = s.broker.drainAuto().closed;
  assert.deepEqual(auto, [{ type: "liquidation", sym: "LMQ" }]);
  const me = s.broker.me(u);
  assert.equal(me.futures.length, 0);
  assert.equal(me.fills[0].side, "liquidation");
  assert.ok(me.cash >= START_CASH * 0.5 - 1e-6, "격리 증거금: 남은 현금은 건드리지 않음");
});

test("스탑로스: 설정 검증 및 목표가 도달 시 자동 종료", async () => {
  const s = setup();
  const u = s.user("stopper");
  await openFut(s, u, "NVDA", "short", 3, 30);
  const f = s.broker.me(u).futures[0];
  const now = s.market.quote("NVDA")!.price;
  assert.throws(() => s.broker.setStop(u, f.id, now * 0.95), OrderError, "숏 스탑로스는 현재가 위여야 함");
  s.broker.setStop(u, f.id, now * 1.002);
  while (s.market.quote("NVDA")!.price <= now * 1.003) s.market.absorbFlow("NVDA", 1e11);
  s.tick();
  const auto = s.broker.drainAuto().closed;
  assert.deepEqual(auto, [{ type: "stop", sym: "NVDA" }]);
  const me = s.broker.me(u);
  assert.equal(me.futures.length, 0);
  assert.equal(me.fills[0].side, "stop");
});

test("주식병합·상장폐지 시 선물 포지션도 함께 조정·정산", async () => {
  const s = setup();
  const u = s.user("corp_fut");
  await openFut(s, u, "LMQ", "long", 3, 20);
  const before = s.broker.me(u).futures[0];
  s.broker.setStop(u, before.id, before.entry * 0.85);
  s.broker.applyActions([{ type: "split", sym: "LMQ", ratio: 10 }]);
  const split = s.broker.me(u).futures[0];
  assert.ok(Math.abs(split.qty - before.qty / 10) < 1e-9);
  assert.ok(Math.abs(split.entry - before.entry * 10) < 1e-9);
  assert.ok(Math.abs(split.stop! - before.entry * 0.85 * 10) < 1e-9);

  const cashBefore = s.broker.me(u).cash;
  const exitPrice = split.entry * 1.1;
  s.broker.applyActions([{ type: "delist", sym: "LMQ", price: exitPrice }]);
  const after = s.broker.me(u);
  assert.equal(after.futures.length, 0);
  const expectedPnl = split.qty * (exitPrice - split.entry);
  assert.ok(Math.abs(after.cash - (cashBefore + split.margin + expectedPnl)) < 1e-6);
});


test("그리기 서버 저장·조회·삭제 및 시즌 분리", () => {
  const s = setup();
  const u = s.user("artist");
  const item = { name: "horizontalStraightLine", points: [{ timestamp: 1000, value: 220 }] };
  s.broker.saveDrawing(u, "NVDA", 1, [item]);
  assert.deepEqual(s.broker.getDrawings(u), { NVDA: { factor: 1, items: [item] } });
  s.broker.saveDrawing(u, "NVDA", 1, []);
  assert.deepEqual(s.broker.getDrawings(u), {});
  s.broker.saveDrawing(u, "BTC", 1, [item]);
  s.broker.clearDrawings(u);
  assert.deepEqual(s.broker.getDrawings(u), {});
});


test("실시간 채팅: 전송·1초 쿨타임·귓속말(/w·/r)·200자·금칙어·3회 신고 자동 숨김·운영자 차단", () => {
  const s = setup();
  const chat = new Chat(s.db);
  const u1 = s.user("alice");
  const u2 = s.user("bob");
  const u3 = s.user("carol");
  const u4 = s.user("dave");

  const m1 = chat.post(u1, "안녕하세요 성투하세요", 10_000);
  assert.equal(m1.name, "alice");
  assert.equal(chat.recent().length, 1);

  assert.throws(() => chat.post(u1, "도배", 10_500), ChatError, "1초 쿨타임");
  const m2 = chat.post(u1, "1초 지남", 11_500);
  assert.equal(chat.recent().length, 2);

  // 귓속말(/w)은 발신자와 수신자에게만 보인다
  const mw = chat.post(u1, "/w bob 비밀 작전 들어가자", 13_000);
  assert.equal(mw.to, "bob");
  assert.equal(chat.recent(50, null).length, 2, "비로그인/타인에게는 귓속말 숨김");
  assert.equal(chat.recent(50, "carol").length, 2, "제3자에게는 귓속말 숨김");
  assert.equal(chat.recent(50, "alice").length, 3, "발신자에게는 귓속말 노출");
  assert.equal(chat.recent(50, "bob").length, 3, "수신자에게는 귓속말 노출");
  // /r: 나에게 마지막으로 귓속말한 사람에게 답장
  const mr = chat.post(u2, "/r 콜 바로 간다", 14_000);
  assert.equal(mr.to, "alice");
  assert.equal(mr.text, "콜 바로 간다");
  assert.throws(() => chat.post(u3, "/r 누구?", 14_000), /답장할 귓속말이 없습니다/);
  chat.post(u1, "/w carol 너도 와", 15_000);
  assert.equal(chat.post(u3, "/r 오케이", 15_000).to, "alice");

  assert.throws(() => chat.post(u2, "a".repeat(201), 15_000), ChatError, "200자 제한");
  assert.throws(() => chat.post(u2, "시발 폭락하네", 15_000), ChatError, "금칙어 차단");

  assert.throws(() => chat.report(u1, m2.id), ChatError, "본인 메시지 신고 불가");
  assert.equal(chat.report(u2, m2.id).hidden, false);
  assert.throws(() => chat.report(u2, m2.id), ChatError, "중복 신고 불가");
  assert.equal(chat.report(u3, m2.id).hidden, false);
  assert.equal(chat.report(u4, m2.id).hidden, true, "3명 신고 시 자동 숨김");
  assert.equal(chat.recent().length, 1);

  chat.setBan("alice", true);
  assert.equal(chat.recent().length, 0, "차단 시 기존 메시지 숨김");
  assert.throws(() => chat.post(u1, "차단됨", 30_000), ChatError);
  assert.deepEqual(chat.adminList().banned, ["alice"]);
});

test("타인 포트폴리오 스캔(portfolioByName): 현물 및 선물 청산가·미실현손익 공개", async () => {
  const s = setup();
  const u = s.user("target_whale");
  await order(s, u, "NVDA", "buy", 10);
  await openFut(s, u, "BTC", "long", 5, 20);
  const pf = s.broker.portfolioByName("target_whale");
  assert.equal(pf.name, "target_whale");
  assert.equal(pf.positions.length, 1);
  assert.equal(pf.positions[0].sym, "NVDA");
  assert.equal(pf.futures.length, 1);
  assert.equal(pf.futures[0].sym, "BTC");
  assert.equal(pf.futures[0].lev, 5);
  assert.ok(pf.futures[0].liq > 0);
});


test("SQLite 무중단 온라인 백업: 시각이 붙은 파일, 최근 keep개만 유지", async () => {
  const s = setup();
  s.user("backup_user");
  const dir = mkdtempSync(join(tmpdir(), "dc-bak-"));
  const f1 = await backupDb(s.db, dir, "test", 2);
  const f2 = await backupDb(s.db, dir, "test", 2);
  const f3 = await backupDb(s.db, dir, "season-end", 2);
  assert.notEqual(f1, f2);
  assert.notEqual(f2, f3);
  const list = readdirSync(dir).filter(f => f.endsWith(".db")).sort();
  assert.equal(list.length, 2, "최근 2개만 유지");
  assert.ok(!list.includes(basename(f1)), "가장 오래된 것부터 지운다");
  const restored = openDb(f3);
  const u = restored.prepare("SELECT name FROM users WHERE name = 'backup_user'").get() as { name: string } | undefined;
  restored.close();
  assert.equal(u?.name, "backup_user");
});


test("일괄매도·일괄종료(closeAll): 현물 다종목과 선물 포지션을 한 tick에 전량 정리", async () => {
  const s = setup();
  const u = s.user("bulk_trader");
  await order(s, u, "NVDA", "buy", 20);
  await order(s, u, "AAPL", "buy", 20);
  await openFut(s, u, "TSLA", "long", 3, 20);
  assert.equal(s.broker.me(u).positions.length, 2);
  assert.equal(s.broker.me(u).futures.length, 1);

  const p = s.broker.closeAll(u, "all");
  s.tick();
  const fills = await p;
  assert.equal(fills.length, 3);
  const after = s.broker.me(u);
  assert.equal(after.positions.length, 0);
  assert.equal(after.futures.length, 0);
});


test("익절(TP): 설정 검증 및 목표가 도달 시 자동 익절 체결", async () => {
  const s = setup();
  const u = s.user("tp_trader");
  await openFut(s, u, "NVDA", "long", 3, 30);
  const f = s.broker.me(u).futures[0];
  const now = s.market.quote("NVDA")!.price;
  assert.throws(() => s.broker.setTp(u, f.id, now * 0.95), OrderError, "롱 익절가는 현재가 위여야 함");
  s.broker.setTp(u, f.id, now * 1.002);
  while (s.market.quote("NVDA")!.price <= now * 1.003) s.market.absorbFlow("NVDA", 1e11);
  s.tick();
  const auto = s.broker.drainAuto().closed;
  assert.deepEqual(auto, [{ type: "tp", sym: "NVDA" }]);
  const me = s.broker.me(u);
  assert.equal(me.futures.length, 0);
  assert.equal(me.fills[0].side, "tp");
  assert.ok((me.fills[0].pnl ?? 0) > 0, "익절 실현손익 양수");
});

test("티배깅·묵념: 강제청산 알림 1건당 처음 누른 한 명만, 시스템 말머리 사칭 차단", () => {
  const s = setup(), chat = new Chat(s.db);
  const victim = s.user("피해자"), a = s.user("구경꾼A"), b = s.user("구경꾼B");
  const liq = chat.system("[강제청산] 💥 피해자님 $NVDA 10x 롱 (증거금 $1,000) 강제청산!");
  assert.throws(() => chat.react(victim, liq.id, "teabag"), /본인 청산/);
  const msg = chat.react(a, liq.id, "teabag", T0);
  assert.ok(msg.text.startsWith("[티배깅]") && msg.text.includes("$NVDA"), msg.text);
  assert.throws(() => chat.react(b, liq.id, "rip", T0 + 5000), /이미 누군가/);
  assert.equal(chat.recent(50).find(m => m.id === liq.id)?.reacted, true, "새로 들어온 화면도 버튼을 숨긴다");
  for (const fake of ["[티배깅] 가짜", "[강제청산] 가짜", "[100배졸업] 가짜", "[공유] 총자산 $999,999,999"])
    assert.throws(() => chat.post(b, fake, T0 + 10_000), /버튼으로만/, fake);
  assert.throws(() => chat.react(a, msg.id, "teabag", T0 + 20_000), /강제청산 알림/, "일반 메시지에는 반응 불가");
});

test("수익인증 공유 문구는 서버가 실제 계좌로 만든다", async () => {
  const s = setup();
  const u = s.user("자랑꾼");
  await order(s, u, "NVDA", "buy", 50);
  assert.match(s.broker.shareText(u, { type: "spot", sym: "NVDA" }), /^\[공유\] \$NVDA 현물 평단 \$[\d,.]+ → 현재 \$[\d,.]+ \([+-][\d.]+%\)$/);
  assert.match(s.broker.shareText(u, { type: "summary" }), /^\[공유\] 총자산 \$[\d,.]+ \([+-][\d.]+%\) · \$NVDA 현물/);
  assert.throws(() => s.broker.shareText(u, { type: "spot", sym: "AMD" }), /보유하지 않은/);
});

test("봇·세력·고래: 같은 주문 경로로 매매, 세력·고래는 랭킹 밖 자기 탭, 명예의 전당은 사람 전설만", () => {
  const s = setup();
  const human = s.user("사람1");
  const bots = new BotRunner(s.db, () => s.broker, () => s.exchange, { bots: 12, marketMakers: true, seed: 3 });
  assert.equal(bots.size, 12 + 20 + 10);
  for (let i = 0; i < 1500; i++) { const r = s.tick(); bots.tick(r.news); }
  const rows = s.broker.ranking(Infinity), mm = s.broker.mmRanking(), whales = s.broker.whaleRanking();
  assert.equal(rows.length, 13, "사람 1 + 봇 12");
  assert.ok(rows.every(r => r.kind === "user" || r.kind === "bot"));
  assert.ok(mm.length === 20 && mm.every(r => r.kind === "mm"), "세력 20");
  assert.ok(whales.length === 10 && whales.every(r => r.kind === "whale"), "🐋 고래 10마리는 별도");
  assert.equal(s.broker.players, 13);
  const fills = s.db.prepare("SELECT COUNT(*) AS c FROM fills f JOIN users u ON u.id = f.user_id WHERE u.kind != 'user'").get() as { c: number };
  assert.ok(fills.c > 20, `봇·세력이 실제로 체결 (${fills.c}건)`);
  assert.throws(() => s.auth.join(rows.find(r => r.kind === "bot")!.name, "secret1"), /봇·세력 계정 이름/);
  // 봇이 전설이어도 명예의 전당에는 사람 전설만
  const bot = rows.find(r => r.kind === "bot")!;
  const botId = (s.db.prepare("SELECT id FROM users WHERE name = ?").get(bot.name) as { id: number }).id;
  s.broker.account(botId).cash = 20_000_000;
  s.broker.account(human).cash = 20_000_000;
  s.tick();
  assert.ok(!s.broker.drainBroadcasts().some(t => t.includes(bot.name)), "봇은 전광판 알림 없음");
  finishSeason(s.db, s.season, s.broker.ranking(Infinity), T0 + s.season.lengthMs + 1000);
  const hall = hallOfFame(s.db).rows;
  assert.deepEqual(hall.map(h => h.name), ["사람1"], "명예의 전당은 사람 전설만");
});

test("🤖 봇이 $1만 아래면 새 봇으로: 빈 번호(처음엔 N+1, 다음엔 직전에 빠진 번호)를 쓰고 $100,000. 🐋 고래는 $100만 아래면 같은 이름으로 $200만", () => {
  const s = setup();
  const bots = new BotRunner(s.db, () => s.broker, () => s.exchange, { bots: 3, marketMakers: true, seed: 4 });
  const num = (n: string) => Number(/봇(\d+)$/.exec(n)![1]);
  const botIds = () => bots.describe().filter(d => d.kind === "bot").map(d => d.userId);
  const nameOf = (id: number) => (s.db.prepare("SELECT name FROM users WHERE id = ?").get(id) as { name: string }).name;
  bots.tick(s.tick().news);
  assert.deepEqual(botIds().map(id => num(nameOf(id))).sort(), [1, 2, 3]);
  const [b1, b2] = botIds().filter(id => [1, 2].includes(num(nameOf(id)))).sort((x, y) => num(nameOf(x)) - num(nameOf(y)));
  s.broker.reset(b1); s.broker.account(b1).cash = 5_000;
  bots.tick(s.tick().news);
  assert.equal(num(nameOf(b1)), 4, "처음 빈 번호 N+1");
  assert.ok(Math.abs(s.broker.equity(s.broker.account(b1)) - START_CASH) < 1e-6, "$100,000로 새로");
  s.broker.reset(b2); s.broker.account(b2).cash = 5_000;
  bots.tick(s.tick().news);
  assert.equal(num(nameOf(b2)), 1, "다음은 직전에 빠진 번호");
  const whale = bots.describe().find(d => d.kind === "whale")!.userId, wname = nameOf(whale);
  s.broker.reset(whale); s.broker.account(whale).cash = 900_000;
  bots.tick(s.tick().news);
  assert.equal(nameOf(whale), wname, "고래 이름 그대로");
  assert.ok(Math.abs(s.broker.equity(s.broker.account(whale)) - 2_000_000) < 1, "고래는 $200만으로");
});

test("🤖 봇 교대: 활동 중인 사람만큼 봇이 쉬고, 사람이 빠지면 다시 깨어난다", () => {
  const s = setup();
  let humans = 0;
  const bots = new BotRunner(s.db, () => s.broker, () => s.exchange, { bots: 10, marketMakers: false, seed: 5, activeHumans: () => humans });
  for (let i = 0; i < 200; i++) { const r = s.tick(); bots.tick(r.news); }
  assert.equal(s.broker.players, 10);
  humans = 4;
  for (let i = 0; i < 200; i++) { const r = s.tick(); bots.tick(r.news); }
  assert.equal(s.broker.players, 6, "사람 4명 → 봇 4명 휴식 (랭킹에서 숨김)");
  assert.equal(s.broker.ranking(Infinity).length, 6);
  humans = 1;
  for (let i = 0; i < 50; i++) { const r = s.tick(); bots.tick(r.news); }
  assert.equal(s.broker.players, 9, "사람이 줄면 봇이 깨어난다");
});

test("이미 불러온 계좌의 종류가 바뀌어도 랭킹에 맞게 나온다 (예전 DB의 세력 고래 → 🐋 고래)", () => {
  const s = setup();
  s.db.prepare("INSERT INTO users (name, pass, created_at, kind) VALUES ('고래', '-', 0, 'mm')").run();
  s.broker.loadAll();
  const id = (s.db.prepare("SELECT id FROM users WHERE name = '고래'").get() as { id: number }).id;
  s.broker.account(id); // 서버가 켜질 때처럼 세력으로 먼저 올라가 있다
  new BotRunner(s.db, () => s.broker, () => s.exchange, { bots: 0, marketMakers: true, seed: 1 });
  assert.ok(s.broker.whaleRanking().some(r => r.name === "고래"), "고래 탭");
  assert.ok(!s.broker.mmRanking().some(r => r.name === "고래"), "세력 현황에는 없음");
});

test("🏦 세력은 세력1~세력N 이름으로 나오고, 예전 전략 이름 계정은 이름만 바뀌어 이어진다. 세력은 20~40분마다 전략을 바꾼다", () => {
  const s = setup();
  s.db.prepare("INSERT INTO users (name, pass, created_at, kind) VALUES ('유동성세력', '-', 0, 'mm')").run();
  const oldId = (s.db.prepare("SELECT id FROM users WHERE name = '유동성세력'").get() as { id: number }).id;
  s.broker.account(oldId);
  const bots = new BotRunner(s.db, () => s.broker, () => s.exchange, { bots: 0, marketMakers: true, seed: 2 });
  bots.tick(s.tick().news); // 첫 tick에 계좌가 올라온다
  const mm = s.broker.mmRanking();
  assert.equal(mm.length, 20);
  assert.ok(mm.every(r => /^세력\d+$/.test(r.name)), "이름에 전략이 드러나지 않음");
  assert.ok(mm.some(r => r.name === "세력1") && (s.db.prepare("SELECT name FROM users WHERE id = ?").get(oldId) as { name: string }).name === "세력1", "예전 계정이 세력1로");
  const before = bots.describe().filter(d => d.kind === "mm").map(d => d.label);
  for (let i = 0; i < 2500; i++) { const r = s.tick(); bots.tick(r.news); }
  const after = bots.describe().filter(d => d.kind === "mm").map(d => d.label);
  assert.ok(after.some((l, i) => l !== before[i]), "전략 교대");
});
