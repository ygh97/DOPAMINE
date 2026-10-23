// 개미 계급 종단 테스트: 이름 옆 계급 배지, 군단장개미(9단계) 입장 전광판(계급 색), 보라 닉네임, 채팅 말풍선 배경, 오른쪽 끝 프로필·경험치 바·프로필 카드 → LP 가이드, 업데이트 내역.
// 실행: node tools/e2e-ranks.cjs [스크린샷 폴더]
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { API, E2E_DB, startServer, startWeb, waitServer, waitWeb, killAll, openApp, outDir } = require("./e2e-lib.cjs");

const OUT = outDir();

(async () => {
  const log = {};
  let errors = [];
  try {
    startServer({ TICK_MS: "200", ENGINE_OPTIONS: JSON.stringify({ warmupBars: 120 }) });
    startWeb();
    await waitServer();
    await waitWeb();
    // 계정을 만들고 LP를 군단장개미(1250~)로 올려 둔다. 입장 알림은 LP가 기준을 넘은 뒤 처음 들어올 때 한 번
    const r = await fetch(`${API}/api/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "군단장", password: "secret1" }) });
    if (!r.ok) throw new Error(`참가 실패 ${r.status}`);
    const db = new DatabaseSync(E2E_DB);
    db.prepare("UPDATE users SET lp = 1300 WHERE name = ?").run("군단장");
    db.close();

    const app = await openApp();
    const { page } = app;
    errors = app.errors;
    await page.fill('.join input[name="name"]', "군단장");
    await page.fill('.join input[name="password"]', "secret1");
    await page.click(".join-btn");
    await page.waitForSelector("#equity");
    await page.waitForSelector("#megaphoneBanner.entry", { timeout: 15000 });
    log.banner = {
      text: await page.locator("#megaphoneBanner .headline").innerText(),
      color: await page.locator("#megaphoneBanner").evaluate(el => getComputedStyle(el).getPropertyValue("--banner-color").trim()),
    };
    if (!log.banner.text.includes("군단장개미 군단장님이 입장") || log.banner.color !== "#c084fc") throw new Error(`입장 전광판이 다름: ${JSON.stringify(log.banner)}`);
    await page.screenshot({ path: path.join(OUT, "ranks-1-entry.png") });

    await page.click('[data-c="chat"]');
    await page.fill("#chatForm input", "군단 집합");
    await page.click('#chatForm button[type="submit"]');
    const mine = page.locator("#chatLog .chat-card", { hasText: "군단 집합" }).last();
    await mine.waitFor();
    log.chat = {
      fill: await mine.evaluate(el => el.classList.contains("tier-fill")),
      badge: await mine.locator(".rank-badge img.rb-ant").count(),
      nameColor: await mine.locator(".chat-user-btn").evaluate(el => getComputedStyle(el).color),
    };
    if (!log.chat.fill || !log.chat.badge || log.chat.nameColor !== "rgb(192, 132, 252)") throw new Error(`채팅 계급 표시가 다름: ${JSON.stringify(log.chat)}`);
    await page.screenshot({ path: path.join(OUT, "ranks-2-chat.png") });

    // 오른쪽 끝 프로필: 큰 개미 + 경험치 바(LP / 다음 계급), 누르면 프로필 카드 → [LP 가이드]
    log.profile = (await page.locator("#topUserNick .pb-head .rank-badge").getAttribute("title")).split(" ")[0];
    if (log.profile !== "군단장개미") throw new Error(`상단 프로필 계급: ${log.profile}`);
    log.xp = await page.locator("#topUserNick .pb-head .xp-text").innerText();
    if (log.xp !== "1,300 / 1,600") throw new Error(`경험치 바: ${log.xp}`);
    log.topbarHeight = await page.locator(".topbar").evaluate(el => el.getBoundingClientRect().height);
    if (log.topbarHeight > 70) throw new Error(`상단 바가 두 줄 (${log.topbarHeight}px)`);
    await page.click("#topUserNick .pb-head");
    await page.waitForSelector(".profile-card .pc-today");
    log.card = { next: await page.locator(".profile-card .pc-next").innerText(), today: await page.locator(".profile-card .pc-today").innerText() };
    await page.screenshot({ path: path.join(OUT, "ranks-3-profile.png") });
    await page.click(".profile-card .pc-guide");
    await page.waitForSelector("#guideDlg[open] #guideLp");
    log.lpGuideTiers = await page.locator("#guideLp .guide-tiers tbody tr").count();
    if (log.lpGuideTiers !== 10) throw new Error(`LP 가이드 계급 ${log.lpGuideTiers}줄`);
    await page.screenshot({ path: path.join(OUT, "ranks-4-lp-guide.png") });
    await page.keyboard.press("Escape");
    // 업데이트 내역: 뉴비 가이드 옆 버튼, 버전별 목록
    await page.click("#updatesBtn");
    await page.waitForSelector("#updatesDlg[open]");
    log.releases = await page.locator("#updatesDlg .release").count();
    if (log.releases < 2) throw new Error(`업데이트 내역 ${log.releases}개`);
    await page.screenshot({ path: path.join(OUT, "ranks-5-updates.png") });
    await page.keyboard.press("Escape");

    // 다시 들어와도 같은 시즌에는 입장 알림을 또 보내지 않는다
    await page.reload();
    await page.waitForSelector("#equity");
    const db2 = new DatabaseSync(E2E_DB);
    log.entryMessages = db2.prepare("SELECT COUNT(*) AS c FROM chat_messages WHERE text LIKE '[입장]%'").get().c;
    db2.close();
    if (log.entryMessages !== 1) throw new Error(`입장 알림 ${log.entryMessages}번`);
    if (errors.length) throw new Error(errors.join("\n"));
    log.ok = true;
  } catch (e) {
    log.failure = e.message;
    process.exitCode = 1;
  } finally {
    console.log(JSON.stringify({ ...log, errors }, null, 1));
    killAll();
  }
})();
