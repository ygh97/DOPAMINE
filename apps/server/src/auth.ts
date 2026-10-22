// 참가(가입 겸 로그인)와 세션. 비밀번호는 Node 내장 scrypt로 해시한다. 복구 기능은 없다 (SPEC 2장).
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.ts";

const NAME = /^[가-힣A-Za-z0-9_]{2,12}$/;

export class AuthError extends Error {}

function hash(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${scryptSync(password, salt, 32).toString("base64")}`;
}
function verify(password: string, stored: string): boolean {
  const [scheme, salt, digest] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !digest) return false; // 봇·시스템 계정은 비밀번호가 없다
  const expected = Buffer.from(digest, "base64");
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

export class Auth {
  private tokens = new Map<string, number>();
  private db: Db;
  private stmts;

  constructor(db: Db) {
    this.db = db;
    this.stmts = {
      selUser: db.prepare("SELECT id, name, pass, kind FROM users WHERE name = ?"),
      insUser: db.prepare("INSERT INTO users (name, pass, created_at) VALUES (?, ?, ?)"),
      insSession: db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)"),
      selSession: db.prepare("SELECT user_id FROM sessions WHERE token = ?"),
      delSession: db.prepare("DELETE FROM sessions WHERE token = ?"),
    };
  }

  /** 처음 보는 이름이면 가입, 있는 이름이면 비밀번호 확인. 성공하면 새 세션 토큰 */
  join(rawName: string, password: string): { token: string; userId: number; name: string; created: boolean } {
    const name = String(rawName ?? "").trim();
    if (!NAME.test(name)) throw new AuthError("이름은 2~12자의 한글·영문·숫자·_만 쓸 수 있습니다.");
    if (typeof password !== "string" || password.length < 6 || password.length > 64) throw new AuthError("비밀번호는 6~64자입니다.");
    const row = this.stmts.selUser.get(name) as { id: number; name: string; pass: string; kind: string } | undefined;
    let userId: number, created = false, shown = name;
    if (row && row.kind !== "user") throw new AuthError("봇·세력 계정 이름이라 쓸 수 없습니다. 다른 이름을 골라 주세요.");
    if (row) {
      if (!verify(password, row.pass)) throw new AuthError("이미 있는 이름이고 비밀번호가 다릅니다. 비밀번호는 복구할 수 없어요.");
      userId = row.id; shown = row.name;
    } else {
      userId = Number(this.stmts.insUser.run(name, hash(password), Date.now()).lastInsertRowid);
      created = true;
    }
    const token = randomBytes(24).toString("base64url");
    this.stmts.insSession.run(token, userId, Date.now());
    this.tokens.set(token, userId);
    return { token, userId, name: shown, created };
  }

  /** Authorization: Bearer 토큰 → 사용자 id (없으면 null) */
  userOf(header: string | undefined): number | null {
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return null;
    const cached = this.tokens.get(token);
    if (cached) return cached;
    const row = this.stmts.selSession.get(token) as { user_id: number } | undefined;
    if (!row) return null;
    this.tokens.set(token, row.user_id);
    return row.user_id;
  }

  logout(header: string | undefined) {
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    this.tokens.delete(token);
    this.stmts.delSession.run(token);
  }
}
