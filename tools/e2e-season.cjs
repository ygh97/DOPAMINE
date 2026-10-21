// M3 종단 테스트: 스냅샷 재시작, 시즌 종료 → 명예의 전당 → 새 시즌($100,000) 전환을 실제 브라우저로 확인한다.
// 서버를 빠른 tick(40ms)과 짧은 시즌(15초)으로 띄운다.
// 실행: node tools/e2e-season.cjs [스크린샷 폴더]
const path = require("node:path");
const { sleep, startServer, startWeb, waitServer, waitWeb, killAll, openApp, outDir } = require("./e2e-lib.cjs");

const OUT = outDir();
const ENV = { TICK_MS: "40", SEASON_MS: "15000", ENGINE_OPTIONS: JSON.stringify({ warmupBars: 120 }) };
const health = async () => (await fetch("http://127.0.0.1:4810/api/health")).json();

(async () => {
  const log = {};
  let errors = [], restarting = false;
  try {
    let server = startServer(ENV);
    startWeb();
    await waitServer();
    await waitWeb();
    const app = await openApp(() => restarting);
    const { browser, page } = app;
    errors = app.errors;
    const clock = () => page.locator(".topbar .clock").innerText();

    // 1) 참가 + 매수 (시즌 1)
    await page.fill('.join input[name="name"]', "시즌왕");
    await page.fill('.join input[name="password"]', "secret1");
    await page.click(".join-btn");
    await page.waitForSelector("#equity");
    await page.click("#watchBody tr[data-sym=NVDA]");
    await page.click(".pct-chips button:has-text('100%')");
    await page.click("#orderBtn");
    await page.waitForSelector("#holdings tr[data-sym=NVDA]");
    log.season1 = { clock: await clock(), equity: await page.locator("#equity").innerText() };

    // 2) 서버 재시작: 스냅샷에서 이어서 (처음부터 재생하지 않음)
    const before = await health();
    restarting = true;
    server.kill();
    await sleep(300);
    server = startServer(ENV);
    await waitServer();
    const after = await health();
    log.restart = { season: after.season, fromSnapshot: after.fromSnapshot, replayed: after.replayed, tickBefore: before.tick, tickAfter: after.tick };
    await page.waitForSelector(".conn.on", { timeout: 15000 });
    restarting = false;
    log.holdingAfterRestart = await page.locator("#holdings tr[data-sym=NVDA]").count();

    // 3) 시즌 종료 → 새 시즌: 시계가 S2, 계좌 $100,000, 보유 비움
    await page.waitForFunction(() => document.querySelector(".topbar .clock")?.textContent.startsWith("S2"), null, { timeout: 30000 });
    await page.waitForFunction(() => document.querySelector("#equity")?.textContent === "$100,000.00", null, { timeout: 10000 });
    log.season2 = { clock: await clock(), equity: await page.locator("#equity").innerText(), holdings: await page.locator("#holdings").count() };

    // 4) 명예의 전당에 시즌 1 기록
    await page.click('[data-c="hall"]');
    await page.waitForSelector("#hall tr");
    log.hall = (await page.locator("#hall").innerText()).split("\n");
    await page.screenshot({ path: path.join(OUT, "m3-hall.png") });
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
