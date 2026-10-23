// 종단 테스트 공통: 서버·Vite 띄우기, 기다리기, 정리, 브라우저 열기.
// Playwright는 REA에 들어 있는 playwright-core를 쓴다 (PW 환경 변수로 경로 변경 가능).
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PW = process.env.PW || path.join(process.env.APPDATA || "", "npm/node_modules/rea-agents/node_modules/playwright-core");
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const VITE = path.join(ROOT, "node_modules/vite/bin/vite.js");
// 개발 서버(4810·5173)와 겹치지 않게 테스트는 다른 포트를 쓴다
const API_PORT = Number(process.env.E2E_PORT ?? 4910), WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5273);
const API = `http://127.0.0.1:${API_PORT}`;
const APP = `http://127.0.0.1:${WEB_PORT}/`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const procs = [];

/** 셸 없이 node를 직접 띄운다. 그래야 kill()로 바로 끝난다 */
function startNode(name, args, cwd, env = {}) {
  const p = spawn(process.execPath, args, { cwd, env: { ...process.env, LOG_LEVEL: "warn", ...env } });
  p.stderr.on("data", d => process.env.VERBOSE && process.stderr.write(`[${name}] ${d}`));
  procs.push(p);
  return p;
}
// 테스트마다 새 DB를 쓴다 (기존 계좌·시즌과 섞이지 않게). pid가 예전 실행과 겹칠 수 있어 남은 파일을 먼저 지운다 (rmSync는 한글 경로에서 죽어 unlinkSync)
const E2E_DB = path.join(require("node:os").tmpdir(), `dc-e2e-${process.pid}.db`);
for (const f of [E2E_DB, `${E2E_DB}-wal`, `${E2E_DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* 없음 */ } }
const startServer = (env = {}) => startNode("server", ["--disable-warning=ExperimentalWarning", "src/index.ts"], path.join(ROOT, "apps/server"),
  { PORT: String(API_PORT), DB_FILE: E2E_DB, SEASON_MS: "28800000", ...env }); // 고정 길이 시즌: 매일 일정(지금 시각에 따라 길이가 바뀜)이면 시세 경로가 실행 시각마다 달라진다
const startWeb = () => startNode("web", [VITE, "--strictPort", "--port", String(WEB_PORT)], path.join(ROOT, "apps/web"), { API_ORIGIN: API });

async function waitFor(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await fetch(url)).ok) return; } catch {} await sleep(300); }
  throw new Error(`응답 없음: ${url}`);
}
const waitServer = () => waitFor(`${API}/api/health`);
const waitWeb = () => waitFor(APP);
const browsers = [];
/** 서버·Vite·브라우저를 모두 끝낸다. 실패 경로에서도 프로세스가 남아 멈추지 않게 5초 뒤 강제 종료 */
const killAll = () => {
  for (const p of procs) p.kill();
  for (const b of browsers) b.close().catch(() => {});
  setTimeout(() => process.exit(process.exitCode ?? 0), 5000).unref();
};

/** 브라우저를 열고 오류를 모은다. ignore()가 true인 동안의 콘솔 오류는 무시 */
async function openApp(ignore = () => false, url = APP) {
  const { chromium } = require(PW);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  browsers.push(browser);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => m.type() === "error" && !ignore() && errors.push(m.text()));
  await page.goto(url);
  await page.waitForSelector("#watchBody tr");
  await page.waitForSelector(".conn.on");
  return { browser, page, errors };
}

/** 명령줄에서 스크린샷 폴더(-- 로 시작하지 않는 첫 인자)를 고른다 */
function outDir() {
  const out = process.argv.slice(2).find(a => !a.startsWith("--")) || path.join(ROOT, "tools", "out");
  fs.mkdirSync(out, { recursive: true });
  return out;
}

module.exports = { ROOT, API, APP, E2E_DB, sleep, startServer, startWeb, waitServer, waitWeb, killAll, openApp, outDir };
