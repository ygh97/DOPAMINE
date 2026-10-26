// 체결층: 호가창 시장가 체결, 선물 포지션 합치기·종료, 지정가 체결 반영, 스탑·익절·강제 청산.
import { MAKER, type Side, type Trade } from "@dopamine/engine";
import { BrokerCore, FEE, MAX_CASCADE, OrderError, floorTo, liqPrice, pnlOf, step, type Account, type Fill, type Future, type Intent } from "./core.ts";

export class BrokerPositions extends BrokerCore {
  protected vwap(trades: Trade[]) {
    let qty = 0, notional = 0;
    for (const t of trades) { qty += t.qty; notional += t.qty * t.price; }
    return { qty, notional, price: qty ? notional / qty : 0 };
  }
  /** 시장가 체결: 호가창을 먹고, 같이 체결된 지정가 주인(maker) 계좌도 반영하고, 순매수를 tick 흐름에 더한다 */
  protected takeMarket(acc: Account, sym: string, side: Side, qty: number) {
    const trades = this.x.marketOrder(acc.userId, sym, side, { qty });
    this.settleTrades(trades);
    const v = this.vwap(trades);
    this.addFlow(acc, sym, side === "buy" ? v.notional : -v.notional);
    return v;
  }

  /**
   * 선물 진입. 같은 종목·방향·배율 포지션이 있으면 거기에 합친다 (물타기·불타기): 수량·증거금은 더하고 진입가는 수량 가중 평균,
   * 청산가는 새 진입가로 다시 계산되고 익절·손절은 그대로. 배율이 다르면 청산가가 달라 따로 둔다
   */
  protected newFuture(acc: Account, sym: string, side: "long" | "short", lev: number, qty: number, entry: number, margin: number): Future {
    for (const g of acc.futures.values()) {
      if (g.sym !== sym || g.side !== side || g.lev !== lev || g.closing) continue;
      g.entry = (g.entry * g.qty + entry * qty) / (g.qty + qty); g.qty += qty; g.margin += margin;
      this.stmts.updFutOpen.run(g.qty, g.entry, g.margin, g.id);
      return g;
    }
    const f: Future = { id: 0, sym, side, lev, qty, entry, margin, stop: null, tp: null, closing: false };
    f.id = Number(this.stmts.insFut.run(acc.userId, this.season.id, sym, side, lev, qty, entry, margin, this.market.tick).lastInsertRowid);
    acc.futures.set(f.id, f);
    return f;
  }

  /** 선물 종료 (사용자 / 강제 청산 / 스탑로스 / 익절). 반대 방향 시장가로 호가를 먹는다 */
  protected closeNow(acc: Account, f: Future, pct: number, reason: "user" | "liquidation" | "stop" | "tp"): Fill {
    return this.atomic([acc.userId], () => {
      const share = Math.min(1, pct / 100);
      const qty = share >= 1 ? f.qty : floorTo(f.qty * share, step(this.x.quote(f.sym)?.market ?? "stock"));
      if (qty <= 0) throw new OrderError("종료할 수량이 1주보다 적습니다. 더 큰 비중으로 종료하세요.");
      const v = this.takeMarket(acc, f.sym, f.side === "long" ? "sell" : "buy", qty);
      if (v.qty <= 0) throw new OrderError("호가가 없어 체결되지 않았습니다.");
      return this.settleClose(acc, f, v.qty, v.price, v.notional * FEE, reason);
    });
  }
  /** 선물 포지션 qty만큼 price에 종료됨 (시장가·종료 지정가 공통): 증거금 몫 + 손익을 돌려주고, 줄어든 만큼 종료 지정가를 맞춘다 */
  protected settleClose(acc: Account, f: Future, qty: number, price: number, fee: number, reason: "user" | "liquidation" | "stop" | "tp"): Fill {
    const part = qty / f.qty, margin = f.margin * part;
    const pnl = pnlOf(f, price, qty);
    acc.cash += Math.max(0, margin + pnl - fee); // 격리: 증거금보다 더 잃지는 않는다
    if (part >= 1 - 1e-9) {
      acc.futures.delete(f.id);
      this.stmts.delFut.run(f.id);
    } else {
      f.qty -= qty; f.margin -= margin; // 스탑로스는 남은 포지션에 유지
      this.stmts.updFutPart.run(f.qty, f.margin, f.id);
    }
    this.trimCloseOrders(acc, f);
    if (reason === "liquidation")
      this.broadcasts.push(`[강제청산] 💥 ${acc.name}님 $${f.sym} ${f.lev}x ${f.side === "long" ? "롱" : "숏"} (증거금 $${Math.round(f.margin).toLocaleString()}) 강제청산!`);
    if (reason !== "user") this.autoClosed.push({ type: reason, sym: f.sym });
    return this.record(acc, f.sym, reason === "user" ? `${f.side}-close` : reason, qty, price, fee, pnl);
  }
  /** 포지션이 줄거나 없어지면 그 포지션의 종료 지정가 합이 남은 수량을 넘지 않게 최근 것부터 취소한다 */
  protected trimCloseOrders(acc: Account, f: Future) {
    const mine = [...this.intents.values()].filter(it => it.reduce && it.posId === f.id && it.userId === acc.userId).sort((a, b) => b.seq - a.seq);
    const room = acc.futures.has(f.id) ? f.qty : 0;
    let total = mine.reduce((s, it) => s + it.qty, 0);
    for (const it of mine) {
      if (total <= room + 1e-9) break;
      this.x.cancel(acc.userId, it.id);
      total -= it.qty;
      this.release(acc, it);
    }
  }

  /**
   * 거래소가 돌려준 체결 중 걸어 둔 지정가(maker)가 사람·봇 것이면 그 계좌에 반영한다 (수수료 0).
   * GameLoop도 exchange.step()이 돌려준 체결(가격이 지나간 지정가를 호가 봇이 받은 것)을 여기로 넘긴다
   */
  settleTrades(trades: Trade[]) {
    for (const t of trades) {
      if (t.maker === MAKER) continue;
      const it = this.intents.get(t.makerOrder);
      if (!it) continue;
      const acc = this.account(it.userId);
      this.fillIntent(acc, it, t.qty, t.price, false);
      if (it.qty <= 1e-9) this.release(acc, it); else this.saveIntent(it);
      this.addFlow(acc, t.sym, 0); // maker는 흐름을 만들지 않는다 (taker 쪽에서 센다)
      this.makerTouched.add(it.sym);
    }
  }
  /** 지정가 주문의 일부(qty)가 price에 체결됨. taker = 걸자마자 바로 체결된 몫 (수수료 냄) */
  protected fillIntent(acc: Account, it: Intent, qty: number, price: number, taker: boolean): Fill {
    const notional = qty * price, fee = taker ? notional * FEE : 0;
    it.qty -= qty; it.filled = (it.filled ?? 0) + qty;
    if (it.reduce) {
      const f = acc.futures.get(it.posId!);
      if (f) return this.settleClose(acc, f, Math.min(qty, f.qty), price, fee, "user");
    }
    if (it.kind === "spot" && it.side === "buy") {
      it.cash -= notional + fee;
      const pos = acc.positions.get(it.sym) ?? { qty: 0, avg: 0 };
      pos.avg = (pos.qty * pos.avg + notional + fee) / (pos.qty + qty);
      pos.qty += qty;
      this.savePosition(acc, it.sym, pos);
      return this.record(acc, it.sym, "buy", qty, price, fee);
    }
    if (it.kind === "spot") {
      it.held -= qty;
      acc.cash += notional - fee;
      return this.record(acc, it.sym, "sell", qty, price, fee, notional - qty * it.avg - fee);
    }
    const margin = notional / it.lev, side = it.side === "buy" ? "long" : "short";
    it.cash -= margin + fee;
    const f = this.newFuture(acc, it.sym, side, it.lev, qty, price, margin); // 같은 종목·방향·배율이면 합쳐진다
    it.posId = f.id;
    return this.record(acc, it.sym, `${side}-open`, qty, price, fee);
  }

  // ---------- 스탑·익절·강제 청산 ----------
  /** 스탑로스 설정·해제 (price = null). 롱은 현재가 아래, 숏은 현재가 위여야 한다 */
  setStop(userId: number, posId: number, price: number | null) {
    const f = this.account(userId).futures.get(posId);
    if (!f) throw new OrderError("선물 포지션을 찾을 수 없습니다.");
    if (price != null) {
      const now = this.price(f.sym);
      if (!Number.isFinite(price) || price <= 0) throw new OrderError("스탑로스 가격이 올바르지 않습니다.");
      if (f.side === "long" ? price >= now : price <= now) throw new OrderError(f.side === "long" ? "롱 스탑로스는 현재가보다 낮아야 합니다." : "숏 스탑로스는 현재가보다 높아야 합니다.");
    }
    f.stop = price;
    this.stmts.updStop.run(price, posId);
  }

  /** 익절(TP) 설정·해제 (price = null). 롱은 현재가 위, 숏은 현재가 아래여야 한다 */
  setTp(userId: number, posId: number, price: number | null) {
    const f = this.account(userId).futures.get(posId);
    if (!f) throw new OrderError("선물 포지션을 찾을 수 없습니다.");
    if (price != null) {
      const now = this.price(f.sym);
      if (!Number.isFinite(price) || price <= 0) throw new OrderError("익절 가격이 올바르지 않습니다.");
      if (f.side === "long" ? price <= now : price >= now) throw new OrderError(f.side === "long" ? "롱 익절가는 현재가보다 높아야 합니다." : "숏 익절가는 현재가보다 낮아야 합니다.");
    }
    f.tp = price;
    this.stmts.updTp.run(price, posId);
  }

  /**
   * 가격이 움직일 때마다(체결 직후, tick마다) 강제 청산·스탑·익절을 바로 처리한다.
   * 청산 매도가 다시 가격을 밀면 다음 청산이 이어질 수 있다 (연쇄). 무한 연쇄를 막으려고 한 번에 최대 MAX_CASCADE건
   */
  runTriggers(sym?: string) {
    for (let n = 0; n < MAX_CASCADE; n++) {
      let hit: { acc: Account; f: Future; reason: "liquidation" | "stop" | "tp" } | null = null;
      for (const acc of this.accounts.values()) {
        for (const f of acc.futures.values()) {
          if (f.closing || (sym && f.sym !== sym)) continue;
          const p = this.price(f.sym), long = f.side === "long";
          if (long ? p <= liqPrice(f) : p >= liqPrice(f)) { hit = { acc, f, reason: "liquidation" }; break; }
          if (f.stop != null && (long ? p <= f.stop : p >= f.stop)) { hit = { acc, f, reason: "stop" }; break; }
          if (f.tp != null && (long ? p >= f.tp : p <= f.tp)) { hit = { acc, f, reason: "tp" }; break; }
        }
        if (hit) break;
      }
      if (!hit) return;
      try { this.closeNow(hit.acc, hit.f, 100, hit.reason); }
      catch { hit.f.closing = true; this.stuck.add(hit.f); } // 호가가 없으면 이번 tick은 건너뛰고 다음 tick에 다시
    }
  }
}
