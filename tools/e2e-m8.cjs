// M8 종단 테스트: 호가창 패널, 지정가 걸기·취소·전체 취소, 다른 사람의 시장가에 내 지정가 체결(수수료 0), 호가 클릭 → 지정가 가격, 최근 체결, 모바일 5단계.
// 실행: node tools/e2e-m8.cjs [스크린샷 폴더]
const path = require("node:path");
const { API, APP, startServer, startWeb, waitServer, waitWeb, killAll, openApp, outDir } = require("./e2e-lib.cjs");

const OUT = outDir();
// 호가창을 얇게 해서 $10만 시장가가 약 0.7% 밀리게 한다 (중간에 tick이 지나도 내 매도 지정가까지 먹는다)
const ENV = { ENGINE_OPTIONS: JSON.stringify({ warmupBars: 120, impactK: 20 }) };

(async () => {
  const log = {};
  let errors = [];
  try {
    startServer(ENV);
    startWeb();
    await waitServer();
    await waitWeb();
    const app = await openApp();
    const { browser, page } = app;
    errors = app.errors;
    const join = async (p, name, pw) => {
      await p.fill('.join input[name="name"]', name);
      await p.fill('.join input[name="password"]', pw);
      await p.click(".join-btn");
      await p.waitForSelector("#equity");
    };
    const toast = p => p.locator(".toast").innerText();
    const orders = () => page.locator("#openOrders tbody tr").count();

    await join(page, "호가왕", "secret1");
    await page.click("#watchBody tr[data-sym=NVDA]");
    await page.waitForSelector("#orderBook .lvl.ask[data-price]");
    log.levels = { asks: await page.locator("#orderBook .lvl.ask[data-price]").count(), bids: await page.locator("#orderBook .lvl.bid[data-price]").count() };

    // 1) 시장가로 조금 사 둔다
    await page.click(".pct-chips button:has-text('20%')");
    await page.click("#orderBtn");
    await page.waitForFunction(() => document.querySelector(".toast")?.textContent.includes("매수"));
    log.tabAfterBuy = await page.locator('[data-t][aria-selected="true"]').getAttribute("data-t"); // 현물 매수 → 보유종목 탭
    const money = async () => Number((await page.locator("#equity").innerText()).replace(/[$,]/g, ""));
    const eq0 = await money();

    // 2) 지정가 매수를 아래에 걸고 → 미체결 1건 → 취소 (걸어 둔 동안에도 총자산은 그대로)
    const book = await (await fetch(`${API}/api/book?sym=NVDA`)).json();
    await page.click('[data-ot="limit"]');
    await page.fill("#limitPrice", String(+(book.bids[0][0] * 0.98).toFixed(2)));
    await page.click(".pct-chips button:has-text('10%')");
    await page.click("#orderBtn");
    await page.waitForSelector("#openOrders tbody tr");
    log.placed = { toast: await toast(page), rows: await orders(), tab: await page.locator('[data-t][aria-selected="true"]').getAttribute("data-t"), equityDiff: Math.abs((await money()) - eq0) };
    await page.waitForTimeout(1100); // 주문 속도 제한: 1초에 2건 (취소 포함)
    await page.click('#openOrders [data-act="cancel"]');
    await page.waitForSelector("#openOrders", { state: "detached" });
    log.cancelled = await toast(page);

    // 3) 두 개 걸고 전체 취소
    for (const k of [0.97, 0.96]) {
      await page.fill("#limitPrice", String(+(book.bids[0][0] * k).toFixed(2)));
      await page.click("#orderBtn");
      await page.waitForFunction(n => document.querySelectorAll("#openOrders tbody tr").length === n, k === 0.97 ? 1 : 2);
      await page.waitForTimeout(1100); // 주문 속도 제한 (tick당 2건)
    }
    await page.waitForTimeout(1100);
    await page.click("#cancelAllBtn");
    await page.waitForSelector("#openOrders", { state: "detached" });
    log.cancelAll = await toast(page);

    // 4) 보유 전량을 최우선 호가 사이(중간)에 매도 지정가로 건다 → 호가창에 내 표시(●)
    const b2 = await (await fetch(`${API}/api/book?sym=NVDA`)).json();
    const mid = Math.round(((b2.asks[0][0] + b2.bids[0][0]) / 2) / b2.tickSize) * b2.tickSize;
    await page.waitForTimeout(1100);
    await page.click('[data-s="sell"]');
    await page.click(".pct-chips button:has-text('100%')");
    await page.fill("#limitPrice", mid.toFixed(2));
    await page.click("#orderBtn");
    await page.waitForSelector("#openOrders tbody tr");
    await page.waitForSelector("#orderBook .mine-dot");
    await page.screenshot({ path: path.join(OUT, "m8-1-book.png") });

    // 5) 다른 사람이 시장가로 크게 사면 내 매도 지정가가 수수료 없이 체결된다
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageB = await ctx.newPage();
    pageB.on("pageerror", e => errors.push(`[B] ${e.message}`));
    await pageB.goto(APP);
    await pageB.waitForSelector(".conn.on");
    await join(pageB, "시장가B", "secret2");
    await pageB.click("#watchBody tr[data-sym=NVDA]");
    await pageB.click(".pct-chips button:has-text('100%')");
    await pageB.click("#orderBtn");
    await pageB.waitForFunction(() => document.querySelector(".toast")?.textContent.includes("매수"));

    await page.waitForSelector("#openOrders", { state: "detached", timeout: 10000 });
    await page.click('[data-t="fills"]');
    const first = (await page.locator("#fills tbody tr").first().innerText()).split("\t");
    log.makerFill = { side: first[3], price: first[5], fee: first[6] };

    // 6) 호가를 누르면 지정가 가격으로 들어간다, 최근 체결 탭
    const askPx = await page.locator("#orderBook .lvl.ask[data-price]").last().getAttribute("data-price");
    await page.locator("#orderBook .lvl.ask[data-price]").last().click();
    log.pick = { ask: Number(askPx), input: Number(await page.inputValue("#limitPrice")) };
    await page.click('[data-b="trades"]');
    await page.waitForSelector("#recentTrades li.up, #recentTrades li.down");
    log.trades = await page.locator("#recentTrades li.up, #recentTrades li.down").count();

    // 7) 모바일: 호가는 주문 패널 위에 5단계씩
    await page.click('[data-b="book"]');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('[data-mv="trade"]');
    await page.waitForTimeout(300);
    log.mobile = {
      asks: await page.locator("#orderBook .lvl.ask:visible").count(),
      bids: await page.locator("#orderBook .lvl.bid:visible").count(),
      bookAboveOrder: await page.evaluate(() => document.querySelector("#orderBook").getBoundingClientRect().top < document.querySelector("#orderBtn").getBoundingClientRect().top),
      scrollX: await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    };
    await page.screenshot({ path: path.join(OUT, "m8-2-mobile.png") });

    // 8) 차트 설정: 포지션 선 종류별 체크박스
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.click('[data-mv="all"]').catch(() => {});
    await page.click("button[title='차트 모양·이평선·수치 표시 직접 설정']");
    log.posChecks = await page.locator("#chartSettingsPanel [data-pos]").count();

    const ok = log.tabAfterBuy === "hold" && log.placed.tab === "orders" && log.placed.equityDiff < 100 && log.posChecks === 6 && log.levels.asks === 10 && log.levels.bids === 10 && log.placed.rows === 1 && log.makerFill.side === "매도" && log.makerFill.fee === "$0.0000"
      && Math.abs(log.pick.ask - log.pick.input) < 1e-9 && log.trades > 0 && log.mobile.asks === 5 && log.mobile.bids === 5 && log.mobile.bookAboveOrder && !log.mobile.scrollX;
    if (!ok) throw new Error("기대와 다름");
    await browser.close();
  } catch (e) {
    log.failure = e.message;
    process.exitCode = 1;
  } finally {
    log.errors = errors;
    if (errors.length) process.exitCode = 1;
    killAll();
    console.log(JSON.stringify(log, null, 1));
  }
})();
