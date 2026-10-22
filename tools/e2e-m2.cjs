// M2 종단 테스트: 두 사람이 참가해서 현물을 사고팔고, 보유종목·체결 내역·랭킹·다시 시작·새로고침 유지를 확인한다.
// 실행: node tools/e2e-m2.cjs [스크린샷 폴더]
const path = require("node:path");
const { API, APP, startServer, startWeb, waitServer, waitWeb, killAll, openApp, outDir } = require("./e2e-lib.cjs");

const OUT = outDir();

(async () => {
  const log = {};
  let errors = [];
  try {
    startServer();
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

    // 1) A 참가 → 계좌 표시
    await join(page, "개미A", "secret1");
    await page.waitForSelector("#equity");
    log.joinA = { toast: await toast(page), equity: await page.locator("#equity").innerText() };

    // 2) NVDA 50% 매수 → 체결 알림, 보유종목, 체결 내역
    await page.click("#watchBody tr[data-sym=NVDA]");
    await page.click(".pct-chips button:has-text('50%')");
    await page.click("#orderBtn");
    await page.waitForSelector("#holdings tr[data-sym=NVDA]");
    log.buy = { toast: await toast(page), holding: (await page.locator("#holdings tr[data-sym=NVDA]").innerText()).split("\t").slice(0, 3) };
    await page.click('[data-t="fills"]');
    log.fills = await page.locator("#fills tbody tr").count();
    await page.click('[data-t="hold"]');
    await page.screenshot({ path: path.join(OUT, "m2-1-bought.png") });

    // 3) 두 번째 사람 B (다른 브라우저 세션)
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageB = await ctx.newPage();
    pageB.on("pageerror", e => errors.push(`[B] ${e.message}`));
    await pageB.goto(APP);
    await pageB.waitForSelector(".conn.on");
    await join(pageB, "개미A", "wrongpw");
    log.wrongPassword = await toast(pageB);
    await join(pageB, "개미B", "secret2");
    await pageB.waitForSelector("#equity");
    await pageB.click('[data-m="coin"]');
    await pageB.click("#watchBody tr[data-sym=BTC]");
    await pageB.click(".pct-chips button:has-text('20%')");
    await pageB.click("#orderBtn");
    await pageB.waitForSelector("#holdings tr[data-sym=BTC]");
    log.buyB = await toast(pageB);

    // 4) 랭킹에 두 사람 (5 tick마다 갱신)
    await page.waitForFunction(() => document.querySelectorAll("#ranking tr").length >= 2, null, { timeout: 15000 });
    log.ranking = (await page.locator("#ranking").innerText()).split("\n").map(l => l.split("\t").slice(0, 2).join(" "));
    log.mineHighlighted = await page.locator("#ranking tr.mine").count();

    // 5) A 전량 매도 → 보유종목 비고, 예수금 회복
    await page.click("#holdings tr[data-sym=NVDA]");
    await page.click(".seg .sell");
    await page.click(".pct-chips button:has-text('100%')");
    await page.click("#orderBtn");
    await page.waitForSelector("#holdings", { state: "detached" });
    log.sellAll = await toast(page);

    // 6) 새로고침해도 참가 상태 유지, 다시 시작
    await page.reload();
    await page.waitForSelector("#equity");
    log.afterReload = await page.locator(".account .kv span").first().innerText();
    page.once("dialog", d => d.accept());
    await page.click(".account button:has-text('다시 시작')");
    await page.waitForFunction(() => document.querySelector("#equity")?.textContent === "$100,000.00");
    log.reset = await page.locator("#equity").innerText();
    await page.screenshot({ path: path.join(OUT, "m2-2-ranking.png") });

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
