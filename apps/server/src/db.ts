// SQLite (Node 내장 node:sqlite). 네이티브 빌드가 없어 Windows·Docker 모두 그대로 돈다.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
      ended_at INTEGER
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
  for (const sql of ["ALTER TABLE seasons ADD COLUMN length_ms INTEGER NOT NULL DEFAULT 604800000", "ALTER TABLE seasons ADD COLUMN ended_at INTEGER"]) {
    try { db.exec(sql); } catch { /* 이미 있음 */ }
  }
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
