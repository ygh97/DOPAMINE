// 주문 접수층: 속도 제한·검사, 현물·선물 시장가, 일괄 정리, 지정가 걸기·종료 지정가·취소·정정, 재시작 때 지정가 복구.
import { LEVERAGE, type Side } from "@dopamine/engine";
import { BrokerPositions } from "./positions.ts";
import { FEE, MAX_OPEN_ORDERS, ORDERS_PER_TICK, OrderError, RESET_LOCKED_LEV, RESET_LOCK_TICKS, floorTo, pickQty, step, type Account, type Fill, type Intent } from "./core.ts";

export class BrokerOrders extends BrokerPositions {
  // ---------- 주문 (호가창에서 즉시 체결) ----------
  protected admit(userId: number, sym: string): Account {
    if (!this.x.quote(sym)) throw new OrderError("거래할 수 없는 종목입니다.");
    const acc = this.account(userId);
    if (acc.kind === "mm") return acc; // 세력은 여러 종목을 한 tick에 다뤄서 속도 제한을 받지 않는다
    const r = this.recent.get(userId);
    const count = r && r.tick === this.market.tick ? r.count : 0;
    if (count >= ORDERS_PER_TICK) throw new OrderError("주문이 너무 빠릅니다. 잠시 후 다시 시도하세요.");
    this.recent.set(userId, { tick: this.market.tick, count: count + 1 });
    return acc;
  }
  /** 수량을 직접 넣었으면 비중은 보지 않는다 */
  protected checkAmount(pct: number, qty?: number) { if (qty == null) this.checkPct(pct); }
  protected checkPct(pct: number) {
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new OrderError("비중은 0~100% 사이여야 합니다.");
  }
  protected checkLev(userId: number, sym: string, lev: number) {
    const q = this.x.quote(sym);
    if (!q) throw new OrderError("거래할 수 없는 종목입니다.");
    if (!LEVERAGE[q.market].includes(lev)) throw new OrderError(`이 종목의 레버리지는 ${LEVERAGE[q.market].join("·")}배만 됩니다.`);
    const acc = this.account(userId);
    if (lev >= RESET_LOCKED_LEV && acc.resetAt != null && this.market.tick - acc.resetAt < RESET_LOCK_TICKS)
      throw new OrderError(`다시 시작한 뒤 10분 동안은 ${RESET_LOCKED_LEV}배 레버리지를 쓸 수 없습니다.`);
  }

  /** 시장가 주문. 바로 체결된다 (Promise는 예전 API 호환). 잘못된 주문은 OrderError를 바로 던진다 */
  place(userId: number, sym: string, side: string, pct: number, qty?: number): Promise<Fill> {
    return Promise.resolve(this.placeNow(userId, sym, side, pct, qty));
  }
  /** 현물 시장가. 매수는 예수금의 pct%, 매도는 보유 수량의 pct%. qty를 주면 그 수량 */
  protected placeNow(userId: number, sym: string, side: string, pct: number, qty?: number): Fill {
    if (side !== "buy" && side !== "sell") throw new OrderError("매수 또는 매도만 할 수 있습니다.");
    this.checkAmount(pct, qty);
    const acc = this.admit(userId, sym), q = this.x.quote(sym)!, unit = step(q.market);
    const pos = acc.positions.get(sym) ?? { qty: 0, avg: 0 };
    if (side === "sell" && !pos.qty) throw new OrderError("보유하지 않은 종목입니다.");
    const fill = this.atomic([userId], () => {
      if (side === "buy") {
        const affordable = floorTo(this.x.qtyFor(userId, sym, "buy", acc.cash / (1 + FEE)), unit);
        const want = qty != null ? pickQty(affordable, unit, pct, qty, "예수금이 부족합니다.")
          : floorTo(this.x.qtyFor(userId, sym, "buy", (acc.cash * pct) / 100 / (1 + FEE)), unit);
        if (want <= 0) throw new OrderError("예수금이 부족해 1주도 살 수 없습니다.");
        const v = this.takeMarket(acc, sym, "buy", want);
        if (v.qty <= 0) throw new OrderError("호가가 없어 체결되지 않았습니다.");
        const fee = v.notional * FEE;
        acc.cash -= v.notional + fee;
        pos.avg = (pos.qty * pos.avg + v.notional + fee) / (pos.qty + v.qty); // 평단은 매수 수수료 포함
        pos.qty += v.qty;
        this.savePosition(acc, sym, pos);
        return this.record(acc, sym, "buy", v.qty, v.price, fee);
      }
      const want = pickQty(pos.qty, unit, pct, qty, "보유 수량보다 많이 팔 수 없습니다.", true); // 전량은 남김 없이
      if (want <= 0) throw new OrderError("팔 수량이 없습니다.");
      const v = this.takeMarket(acc, sym, "sell", want);
      if (v.qty <= 0) throw new OrderError("호가가 없어 체결되지 않았습니다.");
      const fee = v.notional * FEE;
      acc.cash += v.notional - fee;
      pos.qty -= v.qty;
      this.savePosition(acc, sym, pos);
      return this.record(acc, sym, "sell", v.qty, v.price, fee, v.notional - v.qty * pos.avg - fee);
    });
    this.runTriggers(sym);
    return fill;
  }

  openFuture(userId: number, sym: string, side: string, lev: number, pct: number, qty?: number): Promise<Fill> {
    return Promise.resolve(this.openNow(userId, sym, side, lev, pct, qty));
  }
  /** 선물 시장가 진입. 격리 증거금 = 예수금의 pct% (진입 수수료 포함), 명목 = 증거금 × 레버리지 */
  protected openNow(userId: number, sym: string, side: string, lev: number, pct: number, qty?: number): Fill {
    if (side !== "long" && side !== "short") throw new OrderError("롱 또는 숏만 할 수 있습니다.");
    this.checkAmount(pct, qty);
    this.checkLev(userId, sym, lev);
    const acc = this.admit(userId, sym), xs: Side = side === "long" ? "buy" : "sell";
    const fill = this.atomic([userId], () => {
      const unit = step(this.x.quote(sym)!.market), all = acc.cash / (1 + lev * FEE);
      const margin0 = qty != null ? all : (acc.cash * pct) / 100 / (1 + lev * FEE);
      if (margin0 < 1) throw new OrderError("예수금이 부족합니다.");
      const want = qty != null ? pickQty(floorTo(this.x.qtyFor(userId, sym, xs, all * lev), unit), unit, pct, qty, "증거금이 부족합니다.")
        : floorTo(this.x.qtyFor(userId, sym, xs, margin0 * lev), unit);
      if (want <= 0) throw new OrderError("증거금이 부족해 1주도 진입할 수 없습니다.");
      const v = this.takeMarket(acc, sym, xs, want);
      if (v.qty <= 0) throw new OrderError("호가가 없어 체결되지 않았습니다.");
      const margin = v.notional / lev, fee = v.notional * FEE;
      acc.cash -= margin + fee;
      const f = this.newFuture(acc, sym, side, lev, v.qty, v.price, margin);
      return this.record(acc, sym, `${f.side}-open`, v.qty, v.price, fee);
    });
    this.runTriggers(sym);
    return fill;
  }

  closeFuture(userId: number, posId: number, pct: number): Promise<Fill> {
    this.checkPct(pct);
    const f = this.account(userId).futures.get(posId);
    if (!f) throw new OrderError("선물 포지션을 찾을 수 없습니다.");
    if (f.closing) throw new OrderError("이미 청산 중인 포지션입니다.");
    this.admit(userId, f.sym);
    const fill = this.closeNow(this.account(userId), f, pct, "user");
    this.runTriggers(f.sym);
    return Promise.resolve(fill);
  }

  /** 보유 현물·선물 포지션 일괄 100% 시장가 매도·종료 */
  closeAll(userId: number, scope: "spot" | "futures" | "all" = "all"): Promise<Fill[]> {
    {
      const acc = this.account(userId);
      const r = this.recent.get(userId);
      const count = r && r.tick === this.market.tick ? r.count : 0;
      if (count >= ORDERS_PER_TICK) throw new OrderError("주문이 너무 빠릅니다. 잠시 후 다시 시도하세요.");
      const fills: Fill[] = [];
      if (scope === "spot" || scope === "all")
        for (const [sym, p] of [...acc.positions]) {
          if (p.qty <= 0 || !this.x.quote(sym)) continue;
          this.recent.delete(userId); // 일괄 정리는 한 번의 주문으로 센다
          fills.push(this.placeNow(userId, sym, "sell", 100));
        }
      if (scope === "futures" || scope === "all")
        for (const f of [...acc.futures.values()]) if (!f.closing && this.x.quote(f.sym)) { fills.push(this.closeNow(acc, f, 100, "user")); this.runTriggers(f.sym); }
      if (!fills.length) throw new OrderError("정리할 보유종목이나 선물 포지션이 없습니다.");
      this.recent.set(userId, { tick: this.market.tick, count: count + 1 });
      return Promise.resolve(fills);
    }
  }

  // ---------- 지정가 ----------
  /**
   * 지정가 주문. 맞는 호가가 있으면 그만큼 바로 체결(시장가 수수료)하고, 남은 수량은 호가창에 건다(수수료 0).
   * 걸어 둔 동안 필요한 돈(또는 보유 수량)은 묶어 둔다. 체결·취소되면 풀린다.
   * - spot buy: 예수금의 pct%로 살 수 있는 수량, spot sell: 보유 수량의 pct%
   * - fut buy/sell (= 롱/숏 진입): 증거금 = 예수금의 pct%, 명목 = 증거금 × 레버리지
   */
  limitOrder(userId: number, req: { sym: string; kind: "spot" | "fut"; side: Side; price: number; pct: number; qty?: number; lev?: number; reduce?: boolean; posId?: number }) {
    if (req.kind === "fut" && (req.reduce || req.posId != null)) return this.closeLimit(userId, req);
    const { sym, kind, side, pct } = req;
    if (side !== "buy" && side !== "sell") throw new OrderError("매수 또는 매도만 할 수 있습니다.");
    if (!Number.isFinite(req.price) || req.price <= 0) throw new OrderError("가격이 올바르지 않습니다.");
    this.checkAmount(pct, req.qty);
    if (kind === "fut") this.checkLev(userId, sym, req.lev ?? 0);
    const acc = this.admit(userId, sym), q = this.x.quote(sym)!, unit = step(q.market);
    if (this.ordersOf(userId).length >= MAX_OPEN_ORDERS) throw new OrderError(`미체결 주문은 최대 ${MAX_OPEN_ORDERS}개입니다.`);
    const tickSz = this.x.tickOf(sym), price = Math.max(tickSz, Math.round(req.price / tickSz) * tickSz);
    const out = this.atomic([userId], () => {
      const it: Intent = { id: 0, userId, sym, kind, side, lev: req.lev ?? 1, price, qty: 0, cash: 0, held: 0, avg: 0, posId: null, seq: 0 };
      if (kind === "spot" && side === "buy") {
        it.qty = pickQty(floorTo(acc.cash / (price * (1 + FEE)), unit), unit, pct, req.qty, "예수금이 부족합니다.");
        if (it.qty <= 0) throw new OrderError("예수금이 부족합니다.");
        it.cash = it.qty * price * (1 + FEE); acc.cash -= it.cash; // 바로 체결될 몫의 수수료까지 묶는다
      } else if (kind === "spot") {
        const pos = acc.positions.get(sym);
        if (!pos?.qty) throw new OrderError("보유하지 않은 종목입니다.");
        it.qty = pickQty(pos.qty, unit, pct, req.qty, "보유 수량보다 많이 팔 수 없습니다.", true);
        if (it.qty <= 0) throw new OrderError("팔 수량이 없습니다.");
        it.held = it.qty; it.avg = pos.avg; pos.qty -= it.qty; this.savePosition(acc, sym, pos); // 파는 수량을 보유에서 떼어 둔다
      } else {
        it.qty = pickQty(floorTo(((acc.cash / (1 + it.lev * FEE)) * it.lev) / price, unit), unit, pct, req.qty, "증거금이 부족합니다.");
        if (it.qty <= 0) throw new OrderError("증거금이 부족해 1주도 진입할 수 없습니다.");
        it.cash = ((it.qty * price) / it.lev) * (1 + it.lev * FEE); acc.cash -= it.cash; // 증거금 + 바로 체결될 몫의 수수료
      }
      this.stmts.updCash.run(acc.cash, acc.userId, this.season.id);
      const res = this.x.limitOrder(userId, sym, side, price, it.qty);
      // 바로 체결된 몫: 시장가처럼 수수료를 내고 계좌에 반영
      const fills: Fill[] = [];
      if (res.trades.length) {
        this.settleTrades(res.trades);
        const v = this.vwap(res.trades);
        this.addFlow(acc, sym, side === "buy" ? v.notional : -v.notional);
        fills.push(this.fillIntent(acc, it, v.qty, v.price, true));
      }
      if (res.order) {
        it.id = res.order.id; it.seq = res.order.seq; it.qty = res.order.qty;
        this.intents.set(it.id, it);
        this.saveIntent(it);
      } else this.release(acc, it);
      return { fills, order: res.order ? this.orderView(it) : null };
    });
    this.runTriggers(sym);
    return out;
  }

  /**
   * 선물 종료 지정가. posId 포지션(없으면 sym·배율이 같고 주문과 반대 방향인 포지션)을 price에 닫는 주문을 건다.
   * 수량 = 아직 종료 지정가가 걸리지 않은 수량의 pct%. 돈을 묶지 않고, 걸린 채 체결되면 수수료 0
   */
  protected closeLimit(userId: number, req: { sym: string; side: Side; price: number; pct: number; qty?: number; lev?: number; posId?: number }) {
    if (!Number.isFinite(req.price) || req.price <= 0) throw new OrderError("가격이 올바르지 않습니다.");
    this.checkAmount(req.pct, req.qty);
    const acc = this.account(userId), want = req.side === "sell" ? "long" : "short";
    const f = req.posId != null ? acc.futures.get(req.posId)
      : [...acc.futures.values()].find(g => g.sym === req.sym && g.side === want && g.lev === req.lev);
    if (!f || f.closing) throw new OrderError(req.posId != null ? "선물 포지션을 찾을 수 없습니다." : `닫을 ${want === "long" ? "롱" : "숏"} ${req.lev}배 포지션이 없습니다.`);
    this.admit(userId, f.sym);
    if (this.ordersOf(userId).length >= MAX_OPEN_ORDERS) throw new OrderError(`미체결 주문은 최대 ${MAX_OPEN_ORDERS}개입니다.`);
    const unit = step(this.x.quote(f.sym)!.market), side: Side = f.side === "long" ? "sell" : "buy";
    const free = f.qty - [...this.intents.values()].filter(it => it.reduce && it.posId === f.id).reduce((s, it) => s + it.qty, 0);
    if (free < unit - 1e-12) throw new OrderError("포지션 전량에 이미 종료 지정가가 걸려 있습니다.");
    const qty = pickQty(free, unit, req.pct, req.qty, "종료 지정가가 걸리지 않은 수량보다 많습니다.", true);
    if (qty <= 0) throw new OrderError("종료할 수량이 1주보다 적습니다. 더 큰 비중으로 거세요.");
    const tickSz = this.x.tickOf(f.sym), price = Math.max(tickSz, Math.round(req.price / tickSz) * tickSz);
    const out = this.atomic([userId], () => {
      const it: Intent = { id: 0, userId, sym: f.sym, kind: "fut", side, lev: f.lev, price, qty, cash: 0, held: 0, avg: 0, posId: f.id, seq: 0, reduce: true };
      const res = this.x.limitOrder(userId, f.sym, side, price, qty);
      const fills: Fill[] = [];
      if (res.trades.length) {
        this.settleTrades(res.trades);
        const v = this.vwap(res.trades);
        this.addFlow(acc, f.sym, side === "buy" ? v.notional : -v.notional);
        fills.push(this.fillIntent(acc, it, v.qty, v.price, true));
      }
      if (res.order) {
        it.id = res.order.id; it.seq = res.order.seq; it.qty = res.order.qty;
        this.intents.set(it.id, it);
        this.saveIntent(it);
      }
      return { fills, order: res.order ? this.orderView(it) : null };
    });
    this.runTriggers(f.sym);
    return out;
  }

  /** 걸어 둔 지정가 취소. 묶어 둔 돈·수량을 돌려준다 */
  cancelOrder(userId: number, orderId: number) {
    const it = this.intents.get(orderId);
    if (!it || it.userId !== userId) throw new OrderError("미체결 주문을 찾을 수 없습니다.");
    const r = this.recent.get(userId), count = r && r.tick === this.market.tick ? r.count : 0;
    if (count >= ORDERS_PER_TICK && this.account(userId).kind !== "mm") throw new OrderError("주문이 너무 빠릅니다. 잠시 후 다시 시도하세요.");
    this.recent.set(userId, { tick: this.market.tick, count: count + 1 });
    this.x.cancel(userId, orderId);
    this.atomic([userId], () => this.release(this.account(userId), it));
  }
  /**
   * 걸어 둔 지정가의 가격·수량 바꾸기 (차트에서 선을 끌어서, 미체결 탭에서). 취소하고 새 가격에 (qty를 주면 그 수량, 아니면 남은 수량) 다시 건다 (줄 순서는 그 가격의 맨 뒤).
   * 새 가격이 반대 호가를 넘으면 그만큼 바로 체결된다. 다시 걸기가 실패하면 원래 가격에 되돌려 건다
   */
  amendOrder(userId: number, orderId: number, price: number, qty?: number) {
    const it = this.intents.get(orderId);
    if (!it || it.userId !== userId) throw new OrderError("미체결 주문을 찾을 수 없습니다.");
    if (!Number.isFinite(price) || price <= 0) throw new OrderError("가격이 올바르지 않습니다.");
    if (qty != null && (!Number.isFinite(qty) || qty <= 0)) throw new OrderError("수량이 올바르지 않습니다.");
    const req = { sym: it.sym, kind: it.kind, side: it.side, pct: 100, lev: it.lev, ...(it.reduce ? { posId: it.posId! } : {}) };
    this.cancelOrder(userId, orderId);
    try { return this.limitOrder(userId, { ...req, price, qty: qty ?? it.qty }); }
    catch (e) {
      this.recent.delete(userId);
      try { this.limitOrder(userId, { ...req, price: it.price, qty: it.qty }); } catch { /* 원래 주문도 못 걸면 취소된 채로 둔다 (돈·수량은 이미 돌려받음) */ }
      throw e;
    }
  }
  /** 내 미체결 지정가 전체 취소 (한 번의 주문으로 센다). 취소한 개수를 돌려준다 */
  cancelAll(userId: number) {
    const mine = [...this.intents.values()].filter(it => it.userId === userId);
    if (!mine.length) throw new OrderError("취소할 미체결 주문이 없습니다.");
    const r = this.recent.get(userId), count = r && r.tick === this.market.tick ? r.count : 0;
    if (count >= ORDERS_PER_TICK && this.account(userId).kind !== "mm") throw new OrderError("주문이 너무 빠릅니다. 잠시 후 다시 시도하세요.");
    this.recent.set(userId, { tick: this.market.tick, count: count + 1 });
    const acc = this.account(userId);
    this.atomic([userId], () => { for (const it of mine) { this.x.cancel(userId, it.id); this.release(acc, it); } });
    return mine.length;
  }

  /** 재시작: DB에 남은 지정가를 거래소에 다시 건다 */
  restoreOrders() {
    this.x.clearPeopleOrders();
    for (const r of this.stmts.selOrders.all(this.season.id) as unknown as (Omit<Intent, "reduce"> & { pos_id: number | null; reduce: number })[]) {
      const it: Intent = { ...r, posId: r.pos_id, reduce: !!r.reduce };
      if (!this.x.restoreOrder({ id: it.id, owner: it.userId, sym: it.sym, side: it.side, price: it.price, qty: it.qty, seq: it.seq })) {
        this.account(it.userId); this.release(this.account(it.userId), it); continue; // 폐지된 종목이면 돌려준다
      }
      this.intents.set(it.id, it);
      this.account(it.userId);
    }
  }
  /** 병합·폐지로 거래소가 취소한 주문을 돌려준다 */
  refundCancelled(orders: { id: number }[]) {
    for (const o of orders) { const it = this.intents.get(o.id); if (it) this.release(this.account(it.userId), it); }
  }
}
