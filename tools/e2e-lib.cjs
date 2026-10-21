// 종단 테스트 공통: 서버·Vite 띄우기, 기다리기, 정리, 브라우저 열기.
// Playwright는 REA에 들어 있는 playwright-core를 쓴다 (PW 환경 변수로 경로 변경 가능).
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PW = process.env.PW || path.join(process.env.APPDATA || "", "npm/node_modules/rea-agents/node_modules/playwright-core");
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const VITE = path.join(ROOT, "node_modules/vite/bin/vite.js");
const APP = "http://127.0.0.1:5173/";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const procs = [];

/** 셸 없이 node를 직접 띄운다. 그래야 kill()로 바로 끝난다 */
function startNode(name, args, cwd, env = {}) {
  const p = spawn(process.execPath, args, { cwd, env: { ...process.env, LOG_LEVEL: "warn", ...env } });
  p.stderr.on("data", d => process.env.VERBOSE && process.stderr.write(`[${name}] ${d}`));
  procs.push(p);
  return p;
}
// 테스트마다 새 DB를 쓴다 (기존 계좌·시즌과 섞이지 않게)
const startServer = (env = {}) => startNode("server", ["--disable-warning=ExperimentalWarning", "src/index.ts"], path.join(ROOT, "apps/server"),
  { DB_FILE: path.join(require("node:os").tmpdir(), `dc-e2e-${process.pid}.db`), ...env });
const startWeb = () => startNode("web", [VITE, "--strictPort"], path.join(ROOT, "apps/web"));

async function waitFor(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await fetch(url)).ok) return; } catch {} await sleep(300); }
  throw new Error(`응답 없음: ${url}`);
}
const waitServer = () => waitFor("http://127.0.0.1:4810/api/health");
const waitWeb = () => waitFor(APP);
const killAll = () => { for (const p of procs) p.kill(); };

/** 브라우저를 열고 오류를 모은다. ignore()가 true인 동안의 콘솔 오류는 무시 */
async function openApp(ignore = () => false, url = APP) {
  const { chromium } = require(PW);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
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

module.exports = { ROOT, sleep, startServer, startWeb, waitServer, waitWeb, killAll, openApp, outDir };
