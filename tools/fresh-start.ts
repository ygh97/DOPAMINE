// 새로 시작: 계정(닉네임·비밀번호·로그인·채팅 정지)과 명예의 전당만 남기고 시즌·계좌·체결·채팅·그림·스냅샷을 지운다.
// 시즌 번호는 명예의 전당에 기록이 있는 마지막 시즌까지 남기고, 새 시즌은 그다음 번호로 바로 연다 (seed 무작위).
// 서버를 끈 상태에서 실행한다. 보통은 tools/deploy.ps1 -FreshStart가 대신 부른다. 지우기 전에 data/backups에 백업한다.
// 실행: node --disable-warning=ExperimentalWarning tools/fresh-start.ts [DB 파일]
import { randomInt } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { backupDb, openDb, tx } from "../apps/server/src/db.ts";

const file = process.argv[2] ?? fileURLToPath(new URL("../data/dopamine.db", import.meta.url));
const db = openDb(file);
const backup = await backupDb(db, process.env.BACKUP_DIR ?? join(dirname(file), "backups"), "fresh-start");

const keepUpTo = (db.prepare("SELECT MAX(season_id) AS s FROM hall_of_fame").get() as { s: number | null }).s ?? 0;
const next = tx(db, () => {
  for (const t of ["chat_reacts", "chat_reports", "chat_messages", "open_orders", "drawings", "snapshots", "flows", "fills", "futures", "positions", "accounts"])
    db.exec(`DELETE FROM ${t}`);
  db.prepare("DELETE FROM users WHERE kind != 'user'").run(); // 봇·세력·고래 계정은 서버가 켜질 때 다시 만든다
  db.prepare("DELETE FROM seasons WHERE id > ?").run(keepUpTo);
  db.prepare("UPDATE seasons SET ended_at = COALESCE(ended_at, ?)").run(Date.now());
  const id = keepUpTo + 1, seasonMs = Number(process.env.SEASON_MS ?? 28_800_000);
  db.prepare("INSERT INTO seasons (id, seed, started_at, tick_ms, length_ms) VALUES (?, ?, ?, 1000, ?)").run(id, randomInt(1, 2 ** 31), Date.now(), seasonMs);
  return id;
});
db.exec("VACUUM");
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const hall = (db.prepare("SELECT COUNT(*) AS c FROM hall_of_fame").get() as { c: number }).c;
const users = (db.prepare("SELECT COUNT(*) AS c FROM users WHERE id > 0").get() as { c: number }).c;
db.close();
console.log(`새로 시작: 시즌 ${next} 시작 · 계정 ${users}개 · 명예의 전당 ${hall}줄 유지 · 백업 ${backup}`);
