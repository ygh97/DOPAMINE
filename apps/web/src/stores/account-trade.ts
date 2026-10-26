// 내 계좌 스토어의 주문 동작: 현물·선물 시장가, 지정가 걸기·정정·취소, 선물 종료·일괄 정리, 스탑·익절, 다시 시작.
import type { AccountCtx, Fill, Me, OpenOrder } from "./account-types";

export function tradeActions({ api, notify, m, me, busy, holdTab }: AccountCtx) {
  /** 현물 시장가. qty를 주면 비중 대신 그 수량 */
  async function order(sym: string, side: "buy" | "sell", pct: number, qty?: number) {
    busy.value = true;
    try {
      const r = await api<{ fill: Fill; me: Me }>("/api/order", { sym, side, pct, qty });
      me.value = r.me;
      if (side === "buy") holdTab.value = "hold";
      void m.loadRanking();
      m.bookEpoch++;
      const f = r.fill;
      notify(`${f.sym} ${f.side === "buy" ? "매수" : "매도"} ${+f.qty.toFixed(6)}${m.quotes[f.sym]?.market === "coin" ? "" : "주"} @ $${f.price.toFixed(f.price < 1 ? 4 : 2)}`);
    } catch (e) { notify((e as Error).message, "error"); }
    finally { busy.value = false; }
  }

  async function openFuture(sym: string, side: "long" | "short", lev: number, pct: number, qty?: number) {
    busy.value = true;
    try {
      const r = await api<{ fill: Fill; me: Me }>("/api/futures/open", { sym, side, lev, pct, qty });
      me.value = r.me;
      holdTab.value = "fut";
      void m.loadRanking();
      m.bookEpoch++;
      const f = r.fill;
      notify(`${f.sym} ${lev}x ${side === "long" ? "롱" : "숏"} 진입 ${+f.qty.toFixed(6)}${m.quotes[f.sym]?.market === "coin" ? "" : "주"} @ $${f.price.toFixed(f.price < 1 ? 4 : 2)}`);
    } catch (e) { notify((e as Error).message, "error"); }
    finally { busy.value = false; }
  }

  /** 지정가: 바로 체결된 몫은 체결 내역에, 남은 수량은 미체결 탭에 */
  async function limit(req: { sym: string; kind: "spot" | "fut"; side: "buy" | "sell"; price: number; pct: number; qty?: number; lev?: number; reduce?: boolean; posId?: number }) {
    busy.value = true;
    try {
      const r = await api<{ fills: Fill[]; order: OpenOrder | null; me: Me }>("/api/limit", req);
      me.value = r.me;
      void m.loadRanking();
      const filled = r.fills.reduce((s, f) => s + f.qty, 0), unitOf = m.quotes[req.sym]?.market === "coin" ? "" : "주";
      const closing = req.reduce || req.posId != null;
      const what = closing ? `${req.side === "sell" ? "롱" : "숏"} 종료` : req.kind === "fut" ? `${req.lev}x ${req.side === "buy" ? "롱" : "숏"}` : req.side === "buy" ? "매수" : "매도";
      if (r.order) {
        holdTab.value = "orders"; // 남은 수량이 걸렸다
        notify(`${req.sym} ${what} 지정가 $${r.order.price.toFixed(r.order.price < 1 ? 4 : 2)} 걸어 둠${filled ? ` (${+filled.toFixed(6)}${unitOf} 바로 체결)` : ""}`);
      } else {
        if (req.kind === "fut") holdTab.value = "fut"; else if (req.side === "buy") holdTab.value = "hold"; // 전부 바로 체결
        notify(`${req.sym} ${what} 지정가 바로 체결 ${+filled.toFixed(6)}${unitOf}`);
      }
      m.bookEpoch++;
    } catch (e) { notify((e as Error).message, "error"); }
    finally { busy.value = false; }
  }

  async function cancel(id?: number) {
    try {
      const r = await api<{ count: number; me: Me }>("/api/cancel", id == null ? { all: true } : { id });
      me.value = r.me;
      notify(id == null ? `미체결 ${r.count}건을 모두 취소했습니다.` : "주문을 취소했습니다.");
      m.bookEpoch++;
    } catch (e) { notify((e as Error).message, "error"); }
  }

  /** 걸어 둔 지정가 가격·수량 바꾸기 (차트에서 끌어서, 미체결 탭에서) */
  async function amend(id: number, price: number, qty?: number) {
    try {
      const r = await api<{ fills: Fill[]; order: OpenOrder | null; me: Me }>("/api/amend", { id, price, qty });
      me.value = r.me;
      const at = (p: number) => `$${p.toFixed(p < 1 ? 4 : 2)}`;
      notify(r.order ? `지정가를 ${at(r.order.price)} · ${+r.order.qty.toFixed(6)}로 바꿈${r.fills.length ? " (일부 바로 체결)" : ""}` : "새 가격에서 바로 전부 체결됐습니다.");
      m.bookEpoch++;
    } catch (e) { notify((e as Error).message, "error"); }
  }

  async function closeFuture(posId: number, pct: number) {
    busy.value = true;
    try {
      const r = await api<{ fill: Fill; me: Me }>("/api/futures/close", { posId, pct });
      me.value = r.me;
      void m.loadRanking();
      const f = r.fill, pnl = f.pnl ?? 0;
      const pnlText = ` (${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(2)})`;
      notify(`${f.sym} 선물 ${pct >= 100 ? "종료" : `${pct}% 종료`} @ $${f.price.toFixed(f.price < 1 ? 4 : 2)}${pnlText}`);
    } catch (e) { notify((e as Error).message, "error"); }
    finally { busy.value = false; }
  }

  async function closeAll(scope: "spot" | "futures" | "all" = "all") {
    busy.value = true;
    try {
      const r = await api<{ count: number; fills: Fill[]; me: Me }>("/api/close-all", { scope });
      me.value = r.me;
      void m.loadRanking();
      const totalPnl = r.fills.reduce((s, f) => s + (f.pnl ?? 0), 0);
      const label = scope === "spot" ? "현물 일괄매도" : scope === "futures" ? "선물 일괄종료" : "전 포지션 일괄청산";
      notify(`${label} ${r.count}건 완료 (${totalPnl >= 0 ? "+" : "-"}$${Math.abs(totalPnl).toFixed(2)})`);
    } catch (e) { notify((e as Error).message, "error"); }
    finally { busy.value = false; }
  }

  async function setStop(posId: number, price: number | null) {
    try {
      const r = await api<{ me: Me }>("/api/stop", { posId, price });
      me.value = r.me;
      notify(price == null ? "스탑로스를 해제했습니다." : `스탑로스 $${price.toFixed(price < 1 ? 4 : 2)} 설정`);
    } catch (e) { notify((e as Error).message, "error"); }
  }

  async function setTp(posId: number, price: number | null) {
    try {
      const r = await api<{ me: Me }>("/api/tp", { posId, price });
      me.value = r.me;
      notify(price == null ? "익절가를 해제했습니다." : `익절가 $${price.toFixed(price < 1 ? 4 : 2)} 설정`);
    } catch (e) { notify((e as Error).message, "error"); }
  }

  async function reset() {
    try { me.value = (await api<{ me: Me }>("/api/reset", { confirm: true })).me; notify("$100,000부터 다시 시작합니다."); }
    catch (e) { notify((e as Error).message, "error"); }
  }

  return { order, openFuture, limit, amend, cancel, closeFuture, closeAll, setStop, setTp, reset };
}
