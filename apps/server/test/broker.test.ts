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
import { bootMarket, currentSeason, finishSeason, hallOfFame, saveSnapshot } from "../src/season.ts";

const T0 = 1_792_000_000_000;
const FAST = { ticksPerBar: 10, warmupBars: 200 };

function setup(seed = 1) {
  const db = openDb(":memory:");
  const season = currentSeason(db, seed, 1000, 7 * 86_400_000, T0);
  const { market } = bootMarket(db, season, FAST, T0);
  const broker = new Broker(db, season, market);
  const auth = new Auth(db);
  /** 한 tick: 정산 → 엔진 → 상장 변화 정산 */
  const tick = () => { broker.settle(); const r = market.step(); broker.applyActions(r.actions); broker.checkTriggers(); return r; };
  // 서버처럼 참가하면 계좌가 생긴다
  const user = (name: string) => { const id = auth.join(name, "secret1").userId; broker.me(id); return id; };
  return { db, season, market, broker, auth, tick, user };
}
/** 주문을 넣고 다음 tick에 체결 */
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

test("매수: 예수금 비중, 정수 주, 수수료 포함 평단, 자기 충격 + 슬리피지", async () => {
  const s = setup();
  const u = s.user("buyer");
  const pre = s.market.quote("NVDA")!.price;
  const fill = await order(s, u, "NVDA", "buy", 50);
  assert.ok(Number.isInteger(fill.qty) && fill.qty > 0);
  assert.ok(fill.price > pre * 1.0005 - 1e-9, "체결가 ≥ 이전가 × (1 + 슬리피지)");
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

test("같은 tick 주문은 같은 기준가로 체결된다 (방향별 슬리피지만 다름)", async () => {
  const s = setup();
  const a = s.user("alpha"), b = s.user("bravo");
  await order(s, b, "MSFT", "buy", 30);
  const pa = s.broker.place(a, "MSFT", "buy", 20), pb = s.broker.place(b, "MSFT", "sell", 50);
  s.tick();
  const [fa, fb] = await Promise.all([pa, pb]);
  assert.ok(Math.abs(fa.price / 1.0005 - fb.price / 0.9995) < 1e-9, "기준가 동일");
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
  const price = s.market.quote("LMQ")!.price;
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
  saveSnapshot(s.db, s.season, s.market);
  await order(s, u, "LMQ", "buy", 20);
  for (let i = 0; i < 100; i++) s.tick();
  const elapsed = s.market.tick - 2000;
  const boot = bootMarket(s.db, s.season, FAST, T0 + elapsed * 1000);
  assert.ok(boot.fromSnapshot);
  assert.ok(boot.replayed < elapsed, `스냅샷 뒤 ${boot.replayed} tick만 재생`);
  assert.deepEqual(boot.market.quotes(), s.market.quotes());
});

test("시즌 종료: 명예의 전당 기록, 새 시즌은 새 seed와 $100,000 계좌", async () => {
  const s = setup(10);
  const a = s.user("winner"), b = s.user("second"), c = s.user("third"), d = s.user("fourth");
  await order(s, a, "NVDA", "buy", 50);
  void [b, c, d];
  const rows = s.broker.ranking(Infinity);
  const next = finishSeason(s.db, s.season, rows, T0 + s.season.lengthMs + 1000);
  assert.equal(next.id, s.season.id + 1);
  assert.notEqual(next.seed, s.season.seed);
  assert.equal(next.startedAt, T0 + s.season.lengthMs, "이전 시즌이 끝난 시각에 이어서 시작");
  const hall = hallOfFame(s.db) as { season: number; rank: number; name: string }[];
  assert.equal(hall.length, 3, "1~3위만 (100배 달성자 없음)");
  assert.deepEqual(hall.map(h => h.rank), [1, 2, 3]);
  assert.equal(currentSeason(s.db, 1, 1000, 1, T0).id, next.id, "진행 중 시즌 = 새 시즌");
  const { market } = bootMarket(s.db, next, FAST, next.startedAt);
  const broker = new Broker(s.db, next, market);
  assert.equal(broker.me(a).equity, START_CASH);
  assert.equal(broker.me(a).positions.length, 0);
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
  assert.ok(Math.abs(f.margin - expectedMargin) < 1e-6, "예산 안에 진입 수수료 포함");
  assert.ok(Math.abs(me1.cash - START_CASH * 0.8) < 1e-6);
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

test("선물 레버리지 한도 및 다시 시작 후 10분간 5배 초과 금지", async () => {
  const s = setup();
  const u = s.user("lev_tester");
  assert.throws(() => s.broker.openFuture(u, "BTC", "long", 10, 10), OrderError, "코인은 최대 5배");
  assert.throws(() => s.broker.openFuture(u, "LMQ", "short", 10, 10), OrderError, "신흥주는 최대 5배");
  await openFut(s, u, "NVDA", "short", 10, 10);
  s.broker.reset(u);
  assert.equal(s.broker.me(u).futures.length, 0);
  assert.throws(() => s.broker.openFuture(u, "NVDA", "long", 10, 10), OrderError, "리셋 직후 10배 금지");
  await openFut(s, u, "NVDA", "long", 5, 10);
  for (let i = 0; i < 600; i++) s.tick();
  await openFut(s, u, "NVDA", "long", 10, 10);
  assert.equal(s.broker.me(u).futures.length, 2);
});

test("강제 청산: 증거금 90% 손실 시 다음 tick에 시장가 강제 청산", async () => {
  const s = setup();
  const u = s.user("degen");
  await openFut(s, u, "LMQ", "long", 5, 50); // 청산가 = 진입가 × (1 - 0.9/5) = 0.82
  const f = s.broker.me(u).futures[0];
  while (s.market.quote("LMQ")!.price > f.liq * 0.98) s.market.applyFlow("LMQ", -1e9);
  s.broker.checkTriggers(); // 트리거 감지 → 다음 tick 정산 대기열에 등록
  const auto = s.broker.settle();
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
  while (s.market.quote("NVDA")!.price <= now * 1.003) s.market.applyFlow("NVDA", 1e11);
  s.broker.checkTriggers();
  const auto = s.broker.settle();
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


test("실시간 채팅: 전송·1초 쿨타임·귓속말(/w)·200자·금칙어·3회 신고 자동 숨김·운영자 차단", () => {
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
  while (s.market.quote("NVDA")!.price <= now * 1.003) s.market.applyFlow("NVDA", 1e11);
  s.broker.checkTriggers();
  const auto = s.broker.settle();
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

test("봇·세력: 같은 주문 경로로 매매하고, 세력은 랭킹 밖, 명예의 전당은 사람만", () => {
  const s = setup();
  const human = s.user("사람1");
  const bots = new BotRunner(s.db, () => s.broker, () => s.market, { bots: 12, marketMakers: true, seed: 3 });
  assert.equal(bots.size, 12 + 8);
  for (let i = 0; i < 1500; i++) { const r = s.tick(); bots.tick(r.news); }
  const rows = s.broker.ranking(Infinity), mm = s.broker.mmRanking();
  assert.equal(rows.length, 13, "사람 1 + 봇 12");
  assert.ok(rows.every(r => r.kind !== "mm") && mm.length === 8 && mm.every(r => r.kind === "mm"));
  assert.equal(s.broker.players, 13);
  const fills = s.db.prepare("SELECT COUNT(*) AS c FROM fills f JOIN users u ON u.id = f.user_id WHERE u.kind != 'user'").get() as { c: number };
  assert.ok(fills.c > 20, `봇·세력이 실제로 체결 (${fills.c}건)`);
  assert.throws(() => s.auth.join(rows.find(r => r.kind === "bot")!.name, "secret1"), /봇·세력 계정 이름/);
  finishSeason(s.db, s.season, rows, T0 + s.season.lengthMs + 1000);
  const hall = hallOfFame(s.db) as { name: string }[];
  assert.deepEqual(hall.map(h => h.name), ["사람1"], "명예의 전당은 사람만");
  void human;
});
