import assert from "node:assert/strict";
import { test } from "node:test";
import { ASSETS, SECTORS, SPARES } from "../src/catalog.ts";
import { Exchange, MAKER, tickSize } from "../src/exchange.ts";
import { createMarket } from "../src/market.ts";

const NOW = 1_792_000_000_000;
const FAST = { ticksPerBar: 10, warmupBars: 200 };
const make = (seed = 1) => new Exchange(createMarket({ assets: ASSETS, sectors: SECTORS, spares: SPARES, seed, now: NOW, options: FAST }));
const run = (x: Exchange, n: number) => { for (let i = 0; i < n; i++) x.step(); };

test("호가 단위: 가격의 약 0.02%를 1·2·5 단계로", () => {
  assert.equal(tickSize(219.43), 0.05);
  assert.equal(tickSize(94_880), 20);
  assert.ok(Math.abs(tickSize(0.3121) - 0.00005) < 1e-12);
  assert.equal(tickSize(6.88), 0.001);
});

test("호가 봇: 매수 < 매도 (교차 없음), 양쪽 모두 호가가 있다, 가격은 기준가 근처", () => {
  const x = make();
  run(x, 50);
  for (const q of x.quotes()) {
    const b = x.book(q.sym)!;
    assert.ok(b.bids.length >= 5 && b.asks.length >= 5, `${q.sym} 호가 단계`);
    assert.ok(b.bids[0].price < b.asks[0].price, `${q.sym} 교차 없음`);
    assert.ok(Math.abs(q.price / x.reference(q.sym) - 1) < 0.01, `${q.sym} 기준가 근처 (${q.price} vs ${x.reference(q.sym)})`);
  }
});

test("지정가: 가격·시간 우선, 부분 체결, 같은 가격이면 사람 주문이 호가 봇보다 먼저", () => {
  const x = make();
  const sym = "NVDA", { bid, ask } = x.best(sym), t = x.tickOf(sym);
  // 매도 1·2: 최우선 매도보다 한 칸 싸게 → 둘 다 최우선. 먼저 건 1이 먼저 체결
  const a = x.limitOrder(1, sym, "sell", ask! - t, 10), b = x.limitOrder(2, sym, "sell", ask! - t, 10);
  assert.ok(a.order && b.order && !a.trades.length);
  const fills = x.marketOrder(3, sym, "buy", { qty: 15 });
  assert.deepEqual(fills.map(f => [f.maker, f.qty]), [[1, 10], [2, 5]], "먼저 건 주문부터, 2는 부분 체결");
  assert.equal(x.openOrders(2)[0].qty, 5);
  // 매수 지정가를 최우선 매수 가격에 걸면 같은 가격의 호가 봇보다 먼저 체결된다
  x.limitOrder(4, sym, "buy", bid!, 3);
  x.requote(sym); // 호가 봇이 같은 기준가로 다시 깔아도 사람 주문이 먼저다 (기준가가 지나가면 호가 봇이 받는다: 아래 테스트)
  const sells = x.marketOrder(5, sym, "sell", { qty: 2 });
  assert.equal(sells[0].maker, 4, "사람 주문 먼저");
});

test("시장가 매수는 여러 단계를 먹고, 금액이 4배면 대략 2배 밀린다 (제곱근)", () => {
  const move = (notional: number) => {
    const x = make(2), sym = "AAPL", before = x.best(sym).ask!;
    const fills = x.marketOrder(1, sym, "buy", { notional });
    assert.ok(Math.abs(fills.reduce((s, f) => s + f.qty * f.price, 0) - notional) / notional < 1e-6, "예산만큼 체결");
    return fills.at(-1)!.price / before - 1;
  };
  const m1 = move(2_000_000), m4 = move(8_000_000);
  assert.ok(m1 > 0 && m4 / m1 > 1.6 && m4 / m1 < 2.6, `4배 금액 → ${(m4 / m1).toFixed(2)}배 이동`);
});

test("몰려 사면 호가 봇이 숏 재고를 떠안고 중심가를 올린다 (거품), 시간이 지나도 호가는 계속 있다", () => {
  const x = make(3), sym = "TSLA", ref0 = x.reference(sym);
  for (let i = 0; i < 20; i++) { x.marketOrder(1, sym, "buy", { notional: 3_000_000 }); x.step(); }
  assert.ok(x.makerBook(sym)!.inv < 0, "호가 봇 숏 재고");
  assert.ok(x.price(sym) / x.reference(sym) > 1.01, `체결가가 기준가보다 위 (${(x.price(sym) / x.reference(sym)).toFixed(3)}, 시작 기준가 ${ref0})`);
  const b = x.book(sym)!;
  assert.ok(b.bids.length && b.asks.length);
});

test("취소, 자기 주문끼리는 체결하지 않음", () => {
  const x = make();
  const sym = "BTC", { ask } = x.best(sym), t = x.tickOf(sym);
  const s1 = x.limitOrder(7, sym, "sell", ask! - t, 0.5);
  const own = x.marketOrder(7, sym, "buy", { qty: 0.1 });
  assert.ok(own.every(f => f.maker !== 7), "자기 매도는 건너뛴다");
  const s2 = x.limitOrder(8, sym, "sell", ask! + 50 * t, 0.5);
  assert.equal(x.cancel(8, s2.order!.id)?.id, s2.order!.id);
  assert.equal(x.cancel(8, s2.order!.id), null, "두 번 취소 안 됨");
  assert.equal(x.cancel(9, s1.order?.id ?? -1), null, "남의 주문 취소 안 됨");
});

test("캔들 거래량에 실제 체결이 더해지고, 같은 주문이면 같은 결과 (결정론)", () => {
  const go = () => {
    const x = make(5);
    const vol0 = x.bars("NVDA").at(-1)!.volume;
    x.marketOrder(1, "NVDA", "buy", { qty: 500 });
    const vol1 = x.bars("NVDA").at(-1)!.volume;
    run(x, 300);
    x.limitOrder(2, "ETH", "buy", x.best("ETH").bid!, 3);
    run(x, 100);
    return { added: vol1 - vol0, nvda: x.price("NVDA"), eth: x.book("ETH")!.bids.slice(0, 3), snap: x.snapshot().length };
  };
  const a = go(), b = go();
  assert.equal(a.added, 500, "체결 수량이 거래량에");
  assert.deepEqual(a, b);
});

test("스냅샷에서 복원하면 사람 주문·재고·캔들이 이어진다", () => {
  const x = make(6);
  x.marketOrder(1, "META", "buy", { notional: 1_000_000 });
  const o = x.limitOrder(2, "META", "buy", x.best("META").bid! - 10 * x.tickOf("META"), 4).order!;
  const snap = x.snapshot();
  const y = make(6);
  y.restore(snap);
  assert.deepEqual(y.openOrders(2).map(r => r.id), [o.id]);
  assert.equal(y.makerBook("META")!.inv, x.makerBook("META")!.inv);
  assert.deepEqual(y.bars("META").at(-1), x.bars("META").at(-1));
  assert.ok(y.openOrders().every(r => r.owner !== MAKER));
});

test("기준가가 사람 지정가를 지나가면 호가 봇이 그 가격에 받는다 (호가창이 엇갈리지 않음)", () => {
  const x = make(6);
  const sym = "AAPL";
  // 기준가보다 3% 싼 매도 지정가: 시장가가 와야 체결되는 게 아니라 다음 재호가 때 호가 봇이 그 가격에 산다
  const ref = x.reference(sym), t = x.tickOf(sym);
  x.limitOrder(7, sym, "sell", ref * 1.002, 5); // 최우선 매도 근처 (안 엇갈림)
  const deep = Math.round((ref * 0.97) / t) * t;
  x.restoreOrder({ id: 999_999, owner: 8, sym, side: "sell", price: deep, qty: 4, seq: 0 }); // 엇갈린 주문 (재시작 등)
  const r = x.step();
  const got = r.trades.filter(tr => tr.maker === 8);
  assert.equal(got.reduce((s, tr) => s + tr.qty, 0), 4, "엇갈린 지정가 전량 체결");
  assert.ok(got.every(tr => tr.taker === MAKER && tr.price === deep), "호가 봇이 그 지정가 가격에 받음");
  assert.equal(x.openOrders(8).length, 0);
  const b = x.book(sym)!;
  assert.ok(b.bids[0].price < b.asks[0].price, "교차 없음");
});
