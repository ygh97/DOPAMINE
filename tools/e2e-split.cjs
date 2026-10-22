// 주식병합 종단 테스트: 차트에 그린 선이 병합 뒤 새 가격 위치로 옮겨지는지, 액면가가 바뀌는지 확인한다.
// 서버를 빠른 tick(40ms)과 높은 병합 기준($1,000)으로 띄워 첫 게임 하루(80 tick ≈ 3초) 끝에 신흥주가 병합되게 한다.
// 실행: node tools/e2e-split.cjs [스크린샷 폴더]
const path = require("node:path");
const { API, APP, startServer, startWeb, waitServer, waitWeb, killAll, openApp, outDir } = require("./e2e-lib.cjs");

const OUT = outDir();
const STORE = "dc-drawings-v1";

(async () => {
  const log = {};
  let errors = [];
  try {
    // 게임 하루(80 tick) = 8초: 선을 긋기 전에 첫 병합 심사가 오지 않게 여유를 둔다
    startServer({ TICK_MS: "100", ENGINE_OPTIONS: JSON.stringify({ splitPrice: 1000, warmupBars: 120 }) });
    startWeb();
    await waitServer();
    await waitWeb();
    const app = await openApp();
    const { browser, page } = app;
    errors = app.errors;
    const header = async () => ({
      sym: (await page.locator("#qSym").innerText()).split("\n")[0].replace(/[가-힣·\s].*$/, ""),
      par: await page.locator(".stats .kv", { hasText: "액면가" }).locator("b").innerText(),
      price: await page.locator(".big-price").innerText(),
    });
    const pick = async sym => {
      await page.click(`#watchBody tr[data-sym=${sym}]`);
      await page.waitForFunction(s => document.querySelector("#qSym").innerText.startsWith(s), sym);
    };
    const stored = sym => page.evaluate(([k, s]) => JSON.parse(localStorage.getItem(k) || "{}")[s], [STORE, sym]);

    // 1) 아직 병합 전($0.10 액면가)이고 검증 사건 중이 아닌 신흥주를 고른다
    await page.click('[data-m="venture"]');
    const target = await page.evaluate(() => [...document.querySelectorAll("#watchBody tr")]
      .find(tr => !tr.querySelector(".stage"))?.dataset.sym);
    if (!target) throw new Error("병합 전 신흥주를 찾지 못함");
    await pick(target);
    log.target = target;
    log.before = await header();
    if (log.before.par !== "$0.10") throw new Error(`이미 병합됨: ${log.before.par}`);

    // 2) 현재가 근처에 수평선을 긋고, 다른 종목으로 갔다 와서 저장된 값을 읽는다
    await page.click('.tool-group[data-g="0"] .more');
    await page.click('.flyout [data-tool="horizontalStraightLine"]');
    const box = await page.locator("#chart").boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3);
    const other = await page.evaluate(t => [...document.querySelectorAll("#watchBody tr")].find(tr => tr.dataset.sym !== t).dataset.sym, target);
    await pick(other);
    const saved0 = await stored(target);
    log.savedBefore = { factor: saved0.factor, value: saved0.items[0].points[0].value };
    await pick(target);
    await page.screenshot({ path: path.join(OUT, "split-1-before.png") });

    // 3) 병합이 일어날 때까지 기다린다 (헤더 액면가가 바뀜)
    await page.waitForFunction(() => {
      const kv = [...document.querySelectorAll(".stats .kv")].find(k => k.textContent.includes("액면가"));
      return kv && kv.querySelector("b").textContent !== "$0.10";
    }, null, { timeout: 20000 });
    log.after = await header();
    await page.waitForTimeout(500); // 차트가 새 봉을 다시 받는 시간
    await page.screenshot({ path: path.join(OUT, "split-2-after.png") });

    // 4) 다시 저장시켜 읽는다: 배수와 선의 가격이 같은 비율로 커졌는지
    await pick(other);
    const saved1 = await stored(target);
    const ratio = saved1.factor / saved0.factor;
    const parRatio = Number(log.after.par.slice(1)) / Number(log.before.par.slice(1));
    log.savedAfter = { factor: saved1.factor, value: saved1.items[0].points[0].value };
    log.check = {
      ratio,
      parRatio,
      lineScaled: Math.abs(log.savedAfter.value / (log.savedBefore.value * ratio) - 1) < 1e-9,
      parMatches: Math.abs(parRatio / ratio - 1) < 1e-9,
    };
    if (!log.check.lineScaled || !log.check.parMatches) process.exitCode = 1;
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
