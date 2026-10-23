// 새로 시작: 계정(닉네임·비밀번호·로그인·채팅 정지)과 명예의 전당만 남기고 시즌·계좌·체결·채팅·그림·스냅샷을 지운다.
// 시즌 번호는 명예의 전당에 기록이 있는 마지막 시즌까지 남기고, 새 시즌은 그다음 번호로 바로 연다 (seed 무작위).
// --hall: 명예의 전당·TOP 3(엠블럼·메달)과 지난 시즌도 지우고 S1부터 (계정은 남긴다).
// 새 시즌 일정은 서버와 같다: SEASON_MS가 없으면 지금 열어 오늘 23:58에 끝난다.
// 서버를 끈 상태에서 실행한다. 보통은 tools/deploy.ps1 -FreshStart가 대신 부른다. 지우기 전에 data/backups에 백업한다.
// 실행: node --disable-warning=ExperimentalWarning tools/fresh-start.ts [--hall] [DB 파일]
import { randomInt } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { backupDb, openDb, tx } from "../apps/server/src/db.ts";
import { scheduleSeason } from "../apps/server/src/season.ts";

const args = process.argv.slice(2), wipeHall = args.includes("--hall");
const file = args.find(a => !a.startsWith("--")) ?? fileURLToPath(new URL("../data/dopamine.db", import.meta.url));
const db = openDb(file);
const backup = await backupDb(db, process.env.BACKUP_DIR ?? join(dirname(file), "backups"), "fresh-start");

const next = tx(db, () => {
  if (wipeHall) for (const t of ["hall_of_fame", "season_top3"]) db.exec(`DELETE FROM ${t}`);
  const keepUpTo = (db.prepare("SELECT MAX(season_id) AS s FROM hall_of_fame").get() as { s: number | null }).s ?? 0;
  for (const t of ["chat_reacts", "chat_reports", "chat_messages", "open_orders", "drawings", "snapshots", "flows", "fills", "futures", "positions", "accounts"])
    db.exec(`DELETE FROM ${t}`);
  db.prepare("DELETE FROM users WHERE kind != 'user'").run(); // 봇·세력·고래 계정은 서버가 켜질 때 다시 만든다
  db.prepare("DELETE FROM seasons WHERE id > ?").run(keepUpTo);
  db.prepare("UPDATE seasons SET ended_at = COALESCE(ended_at, ?)").run(Date.now());
  const id = keepUpTo + 1, s = scheduleSeason(Date.now(), process.env.SEASON_MS ? Number(process.env.SEASON_MS) : null);
  db.prepare("INSERT INTO seasons (id, seed, started_at, tick_ms, length_ms) VALUES (?, ?, ?, 1000, ?)").run(id, randomInt(1, 2 ** 31), s.startedAt, s.lengthMs);
  return id;
});
db.exec("VACUUM");
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const hall = (db.prepare("SELECT COUNT(*) AS c FROM hall_of_fame").get() as { c: number }).c;
const users = (db.prepare("SELECT COUNT(*) AS c FROM users WHERE id > 0").get() as { c: number }).c;
db.close();
console.log(`새로 시작: 시즌 ${next} 시작 · 계정 ${users}개 · 명예의 전당 ${hall}줄 유지 · 백업 ${backup}`);
