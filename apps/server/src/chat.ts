// 실시간 전체 채팅: 3초 속도 제한, 200자 제한, 금칙어 필터, 신고 누적 자동 숨김, 관리자 밴·숨김 (SPEC 6·10장).
import type { Db } from "./db.ts";

export const COOLDOWN_MS = 3000;
export const MAX_CHAT_LEN = 200;
export const HIDE_REPORTS = 3;

const BAD_WORDS = ["시발", "씨발", "병신", "개새끼", "좆", "꺼져", "도박사이트", "불법환전", "카지노", "계좌이체"];

export class ChatError extends Error {}

export interface ChatMsg { id: number; name: string; text: string; at: number }
export interface ChatAdminMsg extends ChatMsg { reports: number; hidden: boolean }

export class Chat {
  private db: Db;
  private lastSent = new Map<number, number>();

  constructor(db: Db) { this.db = db; }

  post(userId: number, rawText: string, now = Date.now()): ChatMsg {
    const user = this.db.prepare("SELECT name, banned FROM users WHERE id = ?").get(userId) as { name: string; banned: number } | undefined;
    if (!user) throw new ChatError("참가가 필요합니다.");
    if (user.banned) throw new ChatError("채팅이 정지된 계정입니다.");

    const text = String(rawText ?? "").replace(/\s+/g, " ").trim();
    if (!text || text.length > MAX_CHAT_LEN) throw new ChatError(`메시지는 1~${MAX_CHAT_LEN}자여야 합니다.`);

    const prev = this.lastSent.get(userId) ?? 0;
    if (now - prev < COOLDOWN_MS) throw new ChatError("메시지가 너무 빠릅니다. 3초 뒤에 다시 보내세요.");

    const compact = text.replace(/[\s._\-*!@#$%^&()]+/g, "").toLowerCase();
    for (const w of BAD_WORDS) {
      if (compact.includes(w)) throw new ChatError("금칙어가 포함되어 있습니다.");
    }

    this.lastSent.set(userId, now);
    const id = Number(
      this.db.prepare("INSERT INTO chat_messages (user_id, name, text, at) VALUES (?, ?, ?, ?)").run(userId, user.name, text, now).lastInsertRowid,
    );
    return { id, name: user.name, text, at: now };
  }

  recent(limit = 50): ChatMsg[] {
    const rows = this.db.prepare("SELECT id, name, text, at FROM chat_messages WHERE hidden = 0 ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as ChatMsg[];
    return rows.reverse();
  }

  report(userId: number, msgId: number): { id: number; reports: number; hidden: boolean } {
    const msg = this.db.prepare("SELECT id, user_id, hidden FROM chat_messages WHERE id = ?").get(msgId) as { id: number; user_id: number; hidden: number } | undefined;
    if (!msg) throw new ChatError("메시지를 찾을 수 없습니다.");
    if (msg.user_id === userId) throw new ChatError("본인 메시지는 신고할 수 없습니다.");
    const r = this.db.prepare("INSERT OR IGNORE INTO chat_reports (msg_id, user_id) VALUES (?, ?)").run(msgId, userId);
    if (!r.changes) throw new ChatError("이미 신고한 메시지입니다.");
    const { c } = this.db.prepare("SELECT COUNT(*) AS c FROM chat_reports WHERE msg_id = ?").get(msgId) as { c: number };
    const hidden = Boolean(msg.hidden) || c >= HIDE_REPORTS;
    this.db.prepare("UPDATE chat_messages SET reports = ?, hidden = ? WHERE id = ?").run(c, hidden ? 1 : 0, msgId);
    return { id: msgId, reports: c, hidden };
  }

  adminList(limit = 100) {
    const rows = this.db.prepare("SELECT id, name, text, at, reports, hidden FROM chat_messages ORDER BY id DESC LIMIT ?")
      .all(limit) as { id: number; name: string; text: string; at: number; reports: number; hidden: number }[];
    const banned = (this.db.prepare("SELECT name FROM users WHERE banned = 1 ORDER BY id DESC").all() as { name: string }[]).map(u => u.name);
    return {
      messages: rows.map(r => ({ ...r, hidden: Boolean(r.hidden) })),
      banned,
    };
  }

  setHidden(msgId: number, hidden: boolean) {
    this.db.prepare("UPDATE chat_messages SET hidden = ? WHERE id = ?").run(hidden ? 1 : 0, msgId);
  }

  setBan(rawName: string, banned: boolean) {
    const name = String(rawName ?? "").trim();
    const r = this.db.prepare("UPDATE users SET banned = ? WHERE name = ?").run(banned ? 1 : 0, name);
    if (!r.changes) throw new ChatError("사용자를 찾을 수 없습니다.");
    if (banned) this.db.prepare("UPDATE chat_messages SET hidden = 1 WHERE name = ? COLLATE NOCASE").run(name);
  }
}
