// M7 종단 테스트: 웹 프로덕션 빌드 → 단일 포트(4810) 서빙 확인, 단축키(B/S/1~4), 개인정보 처리방침·투자 고지 모달, SQLite 온라인 백업 API.
// 실행: node tools/e2e-m7.cjs [스크린샷 폴더]
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const { ROOT, startServer, waitServer, killAll, openApp, outDir } = require("./e2e-lib.cjs");

const OUT = outDir();
const PROD_URL = "http://127.0.0.1:4810/";

(async () => {
  const log = {};
  let errors = [];
  try {
    // 1) 웹 프로덕션 정적 빌드
    execSync("npm run build --workspace @dopamine/web", { cwd: ROOT, stdio: "pipe" });
    log.webBuilt = fs.existsSync(path.join(ROOT, "apps/web/dist/index.html"));

    // 2) Vite 없이 서버(4810) 단독 기동 → 정적 파일 + API + SSE 단일 포트 서빙 확인
    startServer({ TICK_MS: "80", ADMIN_KEY: "prod-admin-key", ENGINE_OPTIONS: JSON.stringify({ warmupBars: 120 }) });
    await waitServer();

    const app = await openApp(() => false, PROD_URL);
    const { browser, page } = app;
    errors = app.errors;
    log.singlePortServed = true;

    // 3) 단축키 확인: S → 매도, 3 → 50%, B → 매수, 4 → 100%
    await page.click(".quote-head");
    await page.keyboard.press("s");
    await page.keyboard.press("3");
    log.shortcutSell50 = {
      sellPressed: await page.locator('[data-s="sell"]').getAttribute("aria-pressed"),
      pct50Pressed: await page.locator('.pct-chips button:has-text("50%")').getAttribute("aria-pressed"),
    };
    await page.keyboard.press("b");
    await page.keyboard.press("4");
    log.shortcutBuy100 = {
      buyPressed: await page.locator('[data-s="buy"]').getAttribute("aria-pressed"),
      pct100Pressed: await page.locator('.pct-chips button:has-text("100%")').getAttribute("aria-pressed"),
    };

    // 4) 개인정보 처리방침 및 투자 유의 고지 모달 열기·Esc 닫기
    await page.click("#policyBtn");
    await page.waitForSelector("dialog#policyDlg[open]");
    const policyText = await page.locator("#policyDlg").textContent();
    log.policyModal = {
      hasDisclaimer: policyText.includes("실제 투자 권유나 자문으로 해석될 수 없습니다"),
      hasPrivacy: policyText.includes("수집하는 개인정보 항목"),
    };
    await page.screenshot({ path: path.join(OUT, "m7-1-policy-modal.png") });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("dialog#policyDlg[open]"));
    log.policyClosedByEsc = true;

    // 5) 운영자 SQLite 온라인 백업 API 확인
    const bak = await fetch("http://127.0.0.1:4810/api/admin/backup", {
      method: "POST",
      headers: { "x-admin-key": "prod-admin-key" },
    }).then(r => r.json());
    log.backup = { ok: bak.ok, exists: Boolean(bak.file && fs.existsSync(bak.file)) };

    if (
      !log.webBuilt ||
      !log.singlePortServed ||
      log.shortcutSell50.sellPressed !== "true" ||
      log.shortcutSell50.pct50Pressed !== "true" ||
      log.shortcutBuy100.buyPressed !== "true" ||
      log.shortcutBuy100.pct100Pressed !== "true" ||
      !log.policyModal.hasDisclaimer ||
      !log.policyModal.hasPrivacy ||
      !log.policyClosedByEsc ||
      !log.backup.ok ||
      !log.backup.exists ||
      errors.length > 0
    ) {
      process.exitCode = 1;
    }

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
