// SQLite (Node 내장 node:sqlite). 네이티브 빌드가 없어 Windows·Docker 모두 그대로 돈다.
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS seasons (
      id INTEGER PRIMARY KEY,
      seed INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      tick_ms INTEGER NOT NULL,
      length_ms INTEGER NOT NULL DEFAULT 604800000,
      ended_at INTEGER,
      last_seen_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      user_id INTEGER NOT NULL REFERENCES users(id),
      season_id INTEGER NOT NULL REFERENCES seasons(id),
      cash REAL NOT NULL,
      reset_at INTEGER,
      cleared_tick INTEGER,
      PRIMARY KEY (user_id, season_id)
    );
    CREATE TABLE IF NOT EXISTS positions (
      user_id INTEGER NOT NULL,
      season_id INTEGER NOT NULL,
      sym TEXT NOT NULL,
      qty REAL NOT NULL,
      avg REAL NOT NULL,
      PRIMARY KEY (user_id, season_id, sym)
    );
    CREATE TABLE IF NOT EXISTS futures (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      season_id INTEGER NOT NULL REFERENCES seasons(id),
      sym TEXT NOT NULL,
      side TEXT NOT NULL,
      lev INTEGER NOT NULL,
      qty REAL NOT NULL,
      entry REAL NOT NULL,
      margin REAL NOT NULL,
      stop REAL,
      tp REAL,
      opened_tick INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS futures_by_user ON futures (user_id, season_id);
    CREATE TABLE IF NOT EXISTS fills (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      season_id INTEGER NOT NULL,
      tick INTEGER NOT NULL,
      at INTEGER NOT NULL,
      sym TEXT NOT NULL,
      side TEXT NOT NULL,
      qty REAL NOT NULL,
      price REAL NOT NULL,
      fee REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS fills_by_user ON fills (user_id, season_id, id);
    -- tick마다 종목별 순매수 금액. 서버를 다시 켤 때 엔진을 같은 경로로 재생하는 데 쓴다
    CREATE TABLE IF NOT EXISTS flows (
      season_id INTEGER NOT NULL,
      tick INTEGER NOT NULL,
      sym TEXT NOT NULL,
      notional REAL NOT NULL,
      PRIMARY KEY (season_id, tick, sym)
    );
    -- 시즌별 최신 엔진 스냅샷 하나. 재시작 때 여기서부터 이어서 재생한다
    CREATE TABLE IF NOT EXISTS snapshots (
      season_id INTEGER PRIMARY KEY,
      tick INTEGER NOT NULL,
      data TEXT NOT NULL,
      saved_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS drawings (
      user_id INTEGER NOT NULL REFERENCES users(id),
      season_id INTEGER NOT NULL REFERENCES seasons(id),
      sym TEXT NOT NULL,
      factor REAL NOT NULL DEFAULT 1,
      items TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, season_id, sym)
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      text TEXT NOT NULL,
      at INTEGER NOT NULL,
      reports INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS chat_reports (
      msg_id INTEGER NOT NULL REFERENCES chat_messages(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      PRIMARY KEY (msg_id, user_id)
    );
    -- 강제청산 알림 1건당 티배깅·묵념은 한 명만
    CREATE TABLE IF NOT EXISTS chat_reacts (
      msg_id INTEGER PRIMARY KEY REFERENCES chat_messages(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      at INTEGER NOT NULL
    );
    -- 호가창에 걸어 둔 지정가 (M8). 재시작하면 이 표를 기준으로 거래소에 다시 건다
    CREATE TABLE IF NOT EXISTS open_orders (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      season_id INTEGER NOT NULL REFERENCES seasons(id),
      sym TEXT NOT NULL,
      kind TEXT NOT NULL,
      side TEXT NOT NULL,
      lev INTEGER NOT NULL,
      price REAL NOT NULL,
      qty REAL NOT NULL,
      cash REAL NOT NULL,
      held REAL NOT NULL,
      avg REAL NOT NULL,
      pos_id INTEGER,
      seq INTEGER NOT NULL,
      filled REAL NOT NULL DEFAULT 0
    );
    -- 시즌 최종 순위 사람 1·2·3등 (전설이 아니어도). 메달 배지와 명예의 전당 한마디
    CREATE TABLE IF NOT EXISTS season_top3 (
      season_id INTEGER NOT NULL,
      rank INTEGER NOT NULL,
      name TEXT NOT NULL,
      equity REAL NOT NULL,
      return_pct REAL NOT NULL,
      message TEXT,
      PRIMARY KEY (season_id, rank)
    );
    CREATE TABLE IF NOT EXISTS lp_log (
      season_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      rank INTEGER,
      equity REAL,
      delta INTEGER NOT NULL,
      lp INTEGER NOT NULL,
      reason TEXT NOT NULL,
      PRIMARY KEY (season_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS hall_of_fame (
      season_id INTEGER NOT NULL,
      rank INTEGER NOT NULL,
      name TEXT NOT NULL,
      equity REAL NOT NULL,
      return_pct REAL NOT NULL,
      cleared_tick INTEGER,
      PRIMARY KEY (season_id, name)
    );
  `);
  // M2에서 만든 DB에는 시즌 길이·종료 칸이 없다
  for (const sql of [
    "ALTER TABLE seasons ADD COLUMN length_ms INTEGER NOT NULL DEFAULT 604800000",
    "ALTER TABLE seasons ADD COLUMN ended_at INTEGER",
    "ALTER TABLE seasons ADD COLUMN last_seen_at INTEGER", // 서버가 마지막으로 tick을 돌린 시각. 꺼져 있던 시간만큼 시즌 시계를 미룬다
    "ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE fills ADD COLUMN pnl REAL",
    "ALTER TABLE futures ADD COLUMN tp REAL",
    "ALTER TABLE chat_messages ADD COLUMN to_name TEXT",
    // user: 사람, bot: 🤖 봇, mm: 🏦 세력 계정 (봇·세력은 명예의 전당·졸업에서 빠진다)
    "ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'",
    "ALTER TABLE accounts ADD COLUMN grad_tick INTEGER", // 졸업(50배) 시점 (cleared_tick은 100배 전설)
    "ALTER TABLE open_orders ADD COLUMN reduce INTEGER NOT NULL DEFAULT 0", // 선물 종료 지정가 (pos_id 포지션만 줄인다)
    "ALTER TABLE snapshots ADD COLUMN exchange TEXT", // 호가창 상태 (M8): 캔들·호가 봇 재고. 사람 주문은 open_orders
    // 개미 계급 LP (2026-10-24): 시즌을 넘어 남는다. lp_floor = 강등 보호선, idle_seasons = 이어진 비활동 시즌 수, last_equity = 직전 참가 시즌 최종 자산 (LP 동점 순서)
    "ALTER TABLE users ADD COLUMN lp INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN lp_floor INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN idle_seasons INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN last_equity REAL",
    // 시즌(하루) 활동: 첫 체결 때 자산, 거래대금, 마감 4시간 안(20:00~) 체결, 마감 1시간 안(23:00~) 다시 시작
    "ALTER TABLE accounts ADD COLUMN base_equity REAL",
    "ALTER TABLE accounts ADD COLUMN turnover REAL NOT NULL DEFAULT 0",
    "ALTER TABLE accounts ADD COLUMN peak_trade INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE accounts ADD COLUMN late_reset INTEGER NOT NULL DEFAULT 0",
  ]) {
    try { db.exec(sql); } catch { /* 이미 있음 */ }
  }
  // TOP 3 표가 생기기 전에 끝난 시즌: 예전 규칙으로 남은 명예의 전당 1~3위를 TOP 3로 옮겨 둔다 (이미 있으면 그대로)
  db.exec(`INSERT OR IGNORE INTO season_top3 (season_id, rank, name, equity, return_pct)
    SELECT h.season_id, h.rank, h.name, h.equity, h.return_pct FROM hall_of_fame h
    WHERE h.rank <= 3 AND NOT EXISTS (SELECT 1 FROM season_top3 t WHERE t.season_id = h.season_id)`);
  return db;
}

/** fn 안의 쓰기를 한 트랜잭션으로 묶는다 */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}


/** 무중단 SQLite 온라인 백업 (node:sqlite backup API). 파일 이름에 시각을 넣고 최근 keep개만 남긴다 (SPEC 10장) */
let backupSeq = 0;
export async function backupDb(db: Db, dir: string, reason = "auto", keep = 20): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const d = new Date().toISOString().replace(/\D/g, ""); // yyyymmddhhmmssmmm (UTC)
  const seq = String(backupSeq++ % 1000).padStart(3, "0"); // 같은 ms에 여러 번 불러도 이름이 겹치지 않게
  const out = join(dir, `dopamine-${d.slice(0, 8)}-${d.slice(8, 17)}${seq}-${reason}.db`);
  await backup(db, out);
  const old = readdirSync(dir).filter(n => /^dopamine-\d{8}-\d{12}-.+\.db$/.test(n)).sort(); // 이름 = 시각이라 정렬 = 시간순
  // rmSync 대신 unlinkSync: Node 24.11.1의 rmSync는 한글이 든 Windows 경로에서 프로세스째 죽는다
  for (const n of old.slice(0, Math.max(0, old.length - keep))) { try { unlinkSync(join(dir, n)); } catch { /* 이미 없음 */ } }
  return out;
}
