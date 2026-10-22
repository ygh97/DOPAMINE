// 테스트 서버: 봇 100명 + 🏦 세력 8개와 같이 플레이해 보는 용도. 실제 게임 DB와 따로 돈다.
// 실행: npm run dev:test → 화면 http://127.0.0.1:5183 (서버 4820, DB data/test.db)
// 봇 수·세력 세기는 환경 변수로: BOTS=50, MM_TUNING='{"strength":{"liqHunter":0.5}}'
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_PORT = process.env.TEST_PORT ?? "4820", WEB_PORT = process.env.TEST_WEB_PORT ?? "5183";
const env = {
  ...process.env,
  PORT: API_PORT,
  DB_FILE: join(ROOT, "data", "test.db"),
  BACKUP_DIR: join(ROOT, "data", "test-backups"),
  BOTS: process.env.BOTS ?? "100",
  MARKET_MAKERS: process.env.MARKET_MAKERS ?? "1",
  API_ORIGIN: `http://127.0.0.1:${API_PORT}`,
};
const run = (name, args, cwd) => {
  const p = spawn(process.execPath, args, { cwd, env, stdio: "inherit" });
  p.on("exit", code => { console.log(`[${name}] 종료 (${code})`); process.exit(code ?? 0); });
  return p;
};
const server = run("server", ["--env-file-if-exists=../../.env", "--disable-warning=ExperimentalWarning", "--watch", "src/index.ts"], join(ROOT, "apps/server"));
const web = run("web", [join(ROOT, "node_modules/vite/bin/vite.js"), "--strictPort", "--port", WEB_PORT], join(ROOT, "apps/web"));
console.log(`테스트 서버: http://127.0.0.1:${WEB_PORT} (봇 ${env.BOTS}명, 세력 ${env.MARKET_MAKERS === "1" ? "켬" : "끔"}, DB data/test.db)`);
const stop = () => { server.kill(); web.kill(); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
