// M5 종단 테스트: 차트 포지션 선, 그리기 서버 동기화(새 기기 로그인 시 복원), 모바일(390×844) 탭 전환·가로 스크롤 없음을 확인한다.
// 실행: node tools/e2e-m5.cjs [스크린샷 폴더]
const path = require("node:path");
const { API, APP, startServer, startWeb, waitServer, waitWeb, killAll, openApp, outDir } = require("./e2e-lib.cjs");

const OUT = outDir();

(async () => {
  const log = {};
  let errors = [];
  try {
    startServer({ TICK_MS: "80", ENGINE_OPTIONS: JSON.stringify({ warmupBars: 120 }) });
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
    };

    // 1) 참가 → NVDA 현물 매수 + 선물 5x 롱 진입 (차트에 평단·진입가·청산가 선 표시) + 수평선 그리기
    await join(page, "차트장인", "secret1");
    await page.waitForSelector("#equity");
    await page.click("#watchBody tr[data-sym=NVDA]");
    await page.click(".pct-chips button:has-text('20%')");
    await page.click("#orderBtn");
    await page.waitForSelector("#holdings tr[data-sym=NVDA]");

    await page.click('[data-o="fut"]');
    await page.click('[data-lev="5"]');
    await page.click("#orderBtn");
    await page.click('[data-t="fut"]');
    await page.waitForSelector("#futures tr[data-sym=NVDA]");

    await page.click('.tool-group[data-g="0"] .more');
    await page.click('.flyout [data-tool="horizontalStraightLine"]');
    const box = await page.locator("#chart").boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.35);
    await page.screenshot({ path: path.join(OUT, "m5-1-poslines.png") });

    // 2) 새 기기(빈 localStorage)에서 같은 계정 로그인 → 서버에서 그림 복원 확인
    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page2 = await ctx2.newPage();
    page2.on("pageerror", e => errors.push(`[2] ${e.message}`));
    await page2.goto(APP);
    await page2.waitForSelector(".conn.on");
    await join(page2, "차트장인", "secret1");
    await page2.waitForSelector("#equity");
    await page2.waitForFunction(() => {
      const s = JSON.parse(localStorage.getItem("dc-drawings-v1") || "{}");
      return s.NVDA?.items?.length >= 1;
    }, null, { timeout: 10000 });
    log.syncedItems = await page2.evaluate(() => JSON.parse(localStorage.getItem("dc-drawings-v1") || "{}").NVDA.items.length);

    // 3) 모바일 화면(390×844): 가로 스크롤 없음, 하단 탭 전환, 종목 선택 시 차트·주문으로 자동 전환
    const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const pageM = await ctxM.newPage();
    pageM.on("pageerror", e => errors.push(`[M] ${e.message}`));
    await pageM.goto(APP);
    await pageM.waitForSelector(".conn.on");
    await join(pageM, "차트장인", "secret1");
    await pageM.waitForSelector("#equity");

    const noOverflow = () => pageM.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    log.mobile = { allNoOverflow: await noOverflow() };

    await pageM.click('.mobile-nav [data-mv="watch"]');
    await pageM.click("#watchBody tr[data-sym=AAPL]");
    log.mobile.autoSwitchedToTrade = await pageM.locator("main.layout").getAttribute("data-mview");
    log.mobile.tradeNoOverflow = await noOverflow();
    await pageM.screenshot({ path: path.join(OUT, "m5-2-mobile-trade.png") });

    await pageM.click('.mobile-nav [data-mv="hold"]');
    log.mobile.holdNoOverflow = await noOverflow();
    await pageM.click('.mobile-nav [data-mv="social"]');
    log.mobile.socialNoOverflow = await noOverflow();

    if (log.syncedItems < 1 || !log.mobile.allNoOverflow || !log.mobile.tradeNoOverflow || !log.mobile.holdNoOverflow || !log.mobile.socialNoOverflow || log.mobile.autoSwitchedToTrade !== "trade")
      process.exitCode = 1;

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
