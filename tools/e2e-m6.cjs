// M6 종단 테스트: 실시간 채팅(SSE 방송), 1초 속도 제한, 금칙어 차단, 3인 신고 누적 자동 숨김, 운영자 차단(기존 메시지 즉시 삭제).
// 실행: node tools/e2e-m6.cjs [스크린샷 폴더]
const path = require("node:path");
const { API, APP, startServer, startWeb, waitServer, waitWeb, killAll, openApp, outDir } = require("./e2e-lib.cjs");

const OUT = outDir();

(async () => {
  const log = {};
  let errors = [];
  try {
    startServer({ TICK_MS: "80", ADMIN_KEY: "test-admin-key-0123456789", ENGINE_OPTIONS: JSON.stringify({ warmupBars: 120 }) });
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

    // 1) 사용자 A·B 참가 후 채팅 탭으로 이동 → A가 보낸 메시지가 B 화면에 실시간 표시
    await join(page, "개미왕", "secret1");
    await page.click('[data-c="chat"]');

    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page2 = await ctx2.newPage();
    page2.on("pageerror", e => errors.push(`[2] ${e.message}`));
    await page2.goto(APP);
    await page2.waitForSelector(".conn.on");
    await join(page2, "단타신", "secret1");
    await page2.click('[data-c="chat"]');

    await page.fill("#chatForm input", "NVDA 가즈아!");
    await page.click('#chatForm button[type="submit"]');
    await page2.waitForSelector('#chatLog .msg:has-text("NVDA 가즈아!")');
    log.receivedByPeer = true;

    // 2) 1초 쿨타임 거절 토스트 확인
    await page.fill("#chatForm input", "도배 테스트");
    await page.click('#chatForm button[type="submit"]');
    await page.waitForSelector('.toast.error:has-text("1초")');
    log.cooldownBlocked = true;

    // 3) 금칙어 차단 토스트 확인 (B가 전송)
    await page2.fill("#chatForm input", "시발 떡락하네");
    await page2.click('#chatForm button[type="submit"]');
    await page2.waitForSelector('.toast.error:has-text("금칙어")');
    log.profanityBlocked = true;

    // 4) 3인 신고 누적 시 실시간 자동 숨김
    const msgId = Number(await page2.locator("#chatLog .msg").first().getAttribute("data-msg-id"));
    await page2.click('#chatLog .msg [data-act="report"]'); // 1번째 신고 (단타신)
    for (const n of ["신고자2", "신고자3"]) {
      const r = await fetch(`${API}/api/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: n, password: "secret1" }),
      }).then(x => x.json());
      await fetch(`${API}/api/chat/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${r.token}` },
        body: JSON.stringify({ id: msgId }),
      });
    }
    await page.waitForFunction(id => !document.querySelector(`#chatLog .msg[data-msg-id="${id}"]`), msgId);
    log.autoHiddenBy3Reports = true;

    // 5) 운영자 패널에서 사용자 차단 → 해당 사용자의 메시지가 즉시 사라지고 추가 전송 불가
    await page2.fill("#chatForm input", "광고 메시지입니다");
    await page2.click('#chatForm button[type="submit"]');
    await page.waitForSelector('#chatLog .msg:has-text("광고 메시지입니다")');
    await page.screenshot({ path: path.join(OUT, "m6-1-chat.png") });

    await page.click('[data-act="admin-toggle"]');
    await page.fill('#adminPanel input[aria-label="운영자 키"]', "test-admin-key-0123456789");
    await page.click('[data-act="admin-load"]');
    await page.waitForSelector('#adminPanel [data-ban-user="단타신"]');
    await page.click('#adminPanel [data-ban-user="단타신"]');
    await page.waitForFunction(() => !document.querySelector("#chatLog")?.textContent?.includes("광고 메시지입니다"));
    log.purgedOnBan = true;
    await page.screenshot({ path: path.join(OUT, "m6-2-admin.png") });

    if (!log.receivedByPeer || !log.cooldownBlocked || !log.profanityBlocked || !log.autoHiddenBy3Reports || !log.purgedOnBan)
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
