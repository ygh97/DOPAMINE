// M1 종단 테스트: 서버 + Vite를 띄우고 실제 브라우저로 시세·차트·뉴스·그리기·재연결을 확인한다.
// 실행: node tools/e2e-m1.cjs [스크린샷 폴더] [--quick]
const path = require("node:path");
const { sleep, startServer, startWeb, waitServer, waitWeb, killAll, openApp, outDir } = require("./e2e-lib.cjs");

const QUICK = process.argv.includes("--quick"); // 서버 재시작·재연결 확인을 건너뛴다 (약 10초 절약)
const OUT = outDir();

(async () => {
  const log = {};
  let errors = [], restarting = false; // 서버를 일부러 내린 동안의 프록시 500·연결 오류는 정상
  try {
    let server = startServer();
    startWeb();
    await waitServer();
    await waitWeb();
    const app = await openApp(() => restarting);
    const { browser, page } = app;
    errors = app.errors;

    // 1) 시세가 tick마다 바뀌는지. 고정 대기 대신 값이 바뀔 때까지 기다린다
    const price = (sym = "NVDA") => page.locator(`#watchBody tr[data-sym=${sym}] td`).nth(1).innerText();
    const changes = async (sym, ms = 5000) => {
      const first = await price(sym), end = Date.now() + ms;
      while (Date.now() < end) { await sleep(200); const now = await price(sym); if (now !== first) return [first, now]; }
      return [first, first];
    };
    const [p1, p2] = await changes();
    log.priceTicks = { p1, p2, changed: p1 !== p2 };
    log.rows = await page.locator("#watchBody tr").count();
    log.parValue = await page.locator(".stats .kv", { hasText: "액면가" }).locator("b").innerText();

    // 2) 차트
    log.chartCanvas = await page.locator("#chart canvas").count();
    await page.screenshot({ path: path.join(OUT, "m1-1-main.png") });

    // 3) 탭 전환 + 종목 선택
    await page.click('[data-m="coin"]');
    await page.click("#watchBody tr[data-sym=BTC]");
    log.afterSelect = await page.locator("#qSym").innerText();

    // 4) 뉴스: 전광판 클릭 → 상세, 지난 뉴스 목록
    await page.click(".newsline .headline");
    log.newsDetail = await page.locator("#newsDlg h2").innerText();
    await page.click("#newsDlg .dlg-close");
    await page.click(".newsline .icon-btn");
    await page.waitForSelector(".news-list li");
    log.newsListCount = await page.locator(".news-list li").count();
    await page.locator(".news-list button").first().click();
    log.listToDetail = await page.locator("#newsDlg h2").innerText();
    await page.click("#newsDlg .dlg-close");

    // 5) 지표 토글 + 다크 모드
    await page.click('[data-i="MACD"]');
    await page.click(".topbar .icon-btn");
    log.theme = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.screenshot({ path: path.join(OUT, "m1-2-dark-btc.png") });

    // 6) 그리기: 수평선 하나 긋고 종목 왕복 후 유지되는지
    await page.click('.tool-group[data-g="0"] .more');
    await page.click('.flyout [data-tool="horizontalStraightLine"]');
    const box = await page.locator("#chart").boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.35);
    const pick = async sym => {
      await page.click(`#watchBody tr[data-sym=${sym}]`);
      await page.waitForFunction(s => document.querySelector("#qSym").innerText.startsWith(s), sym);
    };
    await pick("ETH"); await pick("BTC");
    log.drawingKept = await page.evaluate(() => JSON.parse(localStorage.getItem("dc-drawings-v1") || "{}").BTC?.items?.length ?? 0);

    // 7) 서버 재시작 → 자동 재연결
    if (!QUICK) {
      restarting = true;
      server.kill();
      await page.waitForSelector(".conn:not(.on)", { timeout: 15000 });
      server = startServer();
      await page.waitForSelector(".conn.on", { timeout: 30000 });
      const [r1, r2] = await changes("BTC");
      log.reconnect = { reconnected: true, ticking: r1 !== r2 };
      restarting = false;
    }
    await sleep(300);
    await browser.close();
  } catch (e) {
    log.failure = e.message;
    process.exitCode = 1;
  } finally {
    log.errors = errors;
    killAll();
    console.log(JSON.stringify(log, null, 1));
  }
})();
