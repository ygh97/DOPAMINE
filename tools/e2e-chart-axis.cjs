// 차트 가격축 종단 테스트: 가격축을 끌어 범위를 바꾼 뒤 가격대가 크게 다른 종목으로 바꿔도, 최신 봉을 보는 동안 가격이 범위 밖으로 나가도 최신 봉이 화면 안에 보인다.
// 실행: node tools/e2e-chart-axis.cjs
const { startServer, startWeb, waitServer, waitWeb, killAll, openApp } = require("./e2e-lib.cjs");

(async () => {
  const log = {};
  let errors = [];
  try {
    startServer({ TICK_MS: "200", ENGINE_OPTIONS: JSON.stringify({ warmupBars: 120 }) });
    startWeb();
    await waitServer();
    await waitWeb();
    const app = await openApp();
    const { page } = app;
    errors = app.errors;
    // 최신 봉 종가가 캔들 영역 안에 그려지는지 (px, 영역 높이)
    const lastBarInView = () => page.evaluate(() => {
      const c = window.__dcChart, d = c.getDataList(), last = d[d.length - 1];
      const px = c.convertToPixel({ timestamp: last.timestamp, value: last.close }, { paneId: "candle_pane" });
      const h = c.getSize("candle_pane", "main")?.height ?? 0;
      return { y: Math.round(px.y), h: Math.round(h), inView: px.y >= 0 && px.y <= h };
    });
    await page.click('[data-m="coin"]'); await page.click('#watchBody tr[data-sym="DOGE"]');
    await page.waitForTimeout(800);
    log.cheap = await lastBarInView();
    // 가격축(오른쪽 끝)을 위아래로 끌어 범위를 고정시킨다 (자동 맞춤이 꺼진다)
    const box = await page.locator("#chart").boundingBox();
    const ax = box.x + box.width - 20, ay = box.y + box.height * 0.35;
    await page.mouse.move(ax, ay); await page.mouse.down(); await page.mouse.move(ax, ay + 120, { steps: 8 }); await page.mouse.up();
    await page.click('#watchBody tr[data-sym="BTC"]');
    await page.waitForTimeout(800);
    log.expensive = await lastBarInView();
    // 같은 종목에서 가격축을 크게 끌어 최신 봉을 화면 밖으로 밀어낸다 → 다음 tick에 다시 자동 맞춤
    await page.mouse.move(ax, ay); await page.mouse.down(); await page.mouse.move(ax, box.y + 5, { steps: 6 }); await page.mouse.move(ax, ay + 400, { steps: 10 }); await page.mouse.up();
    await page.waitForTimeout(1500);
    log.afterDrag = await lastBarInView();
    if (!log.cheap.inView || !log.expensive.inView || !log.afterDrag.inView) throw new Error(`최신 봉이 화면 밖 ${JSON.stringify(log)}`);
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
