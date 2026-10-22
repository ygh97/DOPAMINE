// M4 종단 테스트: 선물 진입(롱·숏·레버리지), 스탑로스 설정·유지, 50% 분할 종료, 강제 청산 자동 반영, 다시 시작 후 10배 제한을 실제 브라우저로 확인한다.
// 실행: node tools/e2e-m4.cjs [스크린샷 폴더]
const path = require("node:path");
const { API, APP, startServer, startWeb, waitServer, waitWeb, killAll, openApp, outDir } = require("./e2e-lib.cjs");

const OUT = outDir();
const ENV = {
  TICK_MS: "60",
  ENGINE_OPTIONS: JSON.stringify({ warmupBars: 120, impactK: 400, impactCap: { stock: 0.25, coin: 0.25, venture: 0.25 } }),
};

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
    };
    const toast = p => p.locator(".toast").innerText();

    // 1) 선물왕 참가 → NVDA 10x 롱 20% 진입
    await join(page, "선물왕", "secret1");
    await page.waitForSelector("#equity");
    await page.click("#watchBody tr[data-sym=NVDA]");
    await page.click('[data-o="fut"]');
    await page.click('[data-lev="10"]');
    await page.click(".pct-chips button:has-text('20%')");
    await page.click("#orderBtn");

    await page.click('[data-t="fut"]');
    await page.waitForSelector("#futures tr[data-sym=NVDA]");
    log.opened = { toast: await toast(page), row: (await page.locator("#futures tr[data-sym=NVDA]").innerText()).split("\t").slice(0, 7) };

    // 2) 스탑로스 $150 설정 → 50% 분할 종료 → 스탑로스 유지 확인 후 해제
    await page.fill("#futures input[aria-label='스탑로스 가격']", "150");
    await page.click('#futures [data-act="stop-set"]');
    await page.waitForSelector('#futures [data-act="stop-clear"]');
    log.stopSet = await page.locator("#futures input[aria-label='스탑로스 가격']").getAttribute("placeholder");

    await page.click('#futures [data-act="close-50"]');
    await page.waitForFunction(() => document.querySelector(".toast")?.textContent.includes("50% 종료"));
    log.partialClose = {
      toast: await toast(page),
      stopKept: await page.locator("#futures input[aria-label='스탑로스 가격']").getAttribute("placeholder"),
      marginAfter: await page.locator("#futures tr[data-sym=NVDA] td:nth-child(7)").innerText(),
    };
    await page.screenshot({ path: path.join(OUT, "m4-1-futures.png") });

    await page.click('#futures [data-act="stop-clear"]');
    await page.waitForSelector('#futures [data-act="stop-clear"]', { state: "detached" });

    // 3) 고래가 NVDA 10x 숏 100%로 가격을 크게 밀어 내림 → 선물왕 10x 롱 강제 청산
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageB = await ctx.newPage();
    pageB.on("pageerror", e => errors.push(`[B] ${e.message}`));
    await pageB.goto(APP);
    await pageB.waitForSelector(".conn.on");
    await join(pageB, "고래B", "secret2");
    await pageB.waitForSelector("#equity");
    await pageB.click("#watchBody tr[data-sym=NVDA]");
    await pageB.click('[data-o="fut"]');
    await pageB.click('[data-s="sell"]');
    await pageB.click('[data-lev="10"]');
    await pageB.click(".pct-chips button:has-text('100%')");
    await pageB.click("#orderBtn");

    await page.waitForSelector("#futures", { state: "detached", timeout: 10000 });
    await page.click('[data-t="fills"]');
    await page.waitForSelector("#fills tbody tr");
    log.fillsAfterLiq = (await page.locator("#fills tbody").innerText()).split("\n").map(r => r.split("\t").slice(1, 4).join(" "));

    // 3-1) 티배깅: 강제청산 알림 1건당 한 명만. 고래B가 채팅의 버튼을 누르면 모두의 화면에서 버튼이 사라진다
    for (const p of [page, pageB]) await p.click('[data-c="chat"]');
    await pageB.waitForSelector('#chatLog [data-act="teabag-mock"]');
    await pageB.click('#chatLog [data-act="teabag-mock"]');
    await pageB.waitForSelector('#chatLog .share-badge.teabag');
    await pageB.waitForSelector('#chatLog [data-act="teabag-mock"]', { state: "detached" });
    await page.waitForSelector('#chatLog [data-act="teabag-mock"]', { state: "detached" });
    log.teabag = await pageB.locator("#chatLog .share-badge.teabag").count();

    // 4) 다시 시작 직후 10배 진입 시도 → 5배 초과 제한 안내
    page.once("dialog", d => d.accept());
    await page.click(".account button:has-text('다시 시작')");
    await page.waitForFunction(() => document.querySelector(".toast")?.textContent.includes("다시 시작"));
    await page.click("#orderBtn");
    await page.waitForFunction(() => document.querySelector(".toast.error")?.textContent.includes("5배"));
    log.resetLock = await toast(page);
    await page.screenshot({ path: path.join(OUT, "m4-2-liquidated.png") });

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
