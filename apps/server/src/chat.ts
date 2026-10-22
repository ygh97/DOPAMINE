// 실시간 전체 채팅 및 귓속말: 1초 속도 제한, 200자 제한, 금칙어 필터, 신고 누적 자동 숨김, 관리자 밴·숨김 (SPEC 6·10장).
import type { Db } from "./db.ts";

export const COOLDOWN_MS = 1000;
export const MAX_CHAT_LEN = 200;
export const HIDE_REPORTS = 3;

const BAD_WORDS = ["시발", "씨발", "병신", "개새끼", "좆", "꺼져", "도박사이트", "불법환전", "카지노", "계좌이체"];

export class ChatError extends Error {}

export interface ChatMsg { id: number; name: string; text: string; at: number; to?: string | null; reacted?: boolean }

// 시스템·서버가 만드는 표시. 일반 채팅으로는 이 말머리로 시작할 수 없다 (사칭 방지)
const RESERVED = ["[티배깅]", "[강제청산]", "[졸업]", "[전설]", "[100배졸업]", "[공유]"];
const LIQ_RE = /^\[강제청산\] 💥 (\S+)님 \$(\S+) /;
export interface ChatAdminMsg extends ChatMsg { reports: number; hidden: boolean }

export class Chat {
  private db: Db;
  private lastSent = new Map<number, number>();
  private recentCache: ChatMsg[] | null = null;
  private stmts;

  constructor(db: Db) {
    this.db = db;
    this.stmts = {
      ensureSys: db.prepare("INSERT OR IGNORE INTO users (id, name, pass, created_at) VALUES (0, '⚡전광판', '-', 0)"),
      insMsg: db.prepare("INSERT INTO chat_messages (user_id, name, text, at, to_name) VALUES (?, ?, ?, ?, ?)"),
      selUser: db.prepare("SELECT name, banned FROM users WHERE id = ?"),
      selTarget: db.prepare("SELECT name FROM users WHERE name = ? COLLATE NOCASE"),
      // 공개 메시지만 캐시한다 (귓속말이 많아도 공개 메시지 수가 줄지 않게). reacted = 강제청산 알림에 누가 이미 반응했는지
      selRecent: db.prepare('SELECT m.id, m.name, m.text, m.at, NULL AS "to", r.msg_id IS NOT NULL AS reacted FROM chat_messages m LEFT JOIN chat_reacts r ON r.msg_id = m.id WHERE m.hidden = 0 AND m.to_name IS NULL ORDER BY m.id DESC LIMIT ?'),
      selWhispers: db.prepare('SELECT id, name, text, at, to_name AS "to" FROM chat_messages WHERE hidden = 0 AND to_name IS NOT NULL AND (name = ?1 COLLATE NOCASE OR to_name = ?1 COLLATE NOCASE) ORDER BY id DESC LIMIT ?2'),
      selSysMsg: db.prepare("SELECT text FROM chat_messages WHERE id = ? AND user_id = 0"),
      insReact: db.prepare("INSERT OR IGNORE INTO chat_reacts (msg_id, user_id, at) VALUES (?, ?, ?)"),
      selMsg: db.prepare("SELECT id, user_id, hidden FROM chat_messages WHERE id = ?"),
      insReport: db.prepare("INSERT OR IGNORE INTO chat_reports (msg_id, user_id) VALUES (?, ?)"),
      cntReport: db.prepare("SELECT COUNT(*) AS c FROM chat_reports WHERE msg_id = ?"),
      updReport: db.prepare("UPDATE chat_messages SET reports = ?, hidden = ? WHERE id = ?"),
      selAdmin: db.prepare('SELECT id, name, text, at, to_name AS "to", reports, hidden FROM chat_messages ORDER BY id DESC LIMIT ?'),
      selBanned: db.prepare("SELECT name FROM users WHERE banned = 1 ORDER BY id DESC"),
      updHidden: db.prepare("UPDATE chat_messages SET hidden = ? WHERE id = ?"),
      updBan: db.prepare("UPDATE users SET banned = ? WHERE name = ?"),
      hideUserMsgs: db.prepare("UPDATE chat_messages SET hidden = 1 WHERE name = ? COLLATE NOCASE"),
    };
  }

  /** 시스템 전광판 방송 메시지 기록 (100배 졸업·강제청산 알림) */
  system(text: string, now = Date.now()): ChatMsg {
    this.stmts.ensureSys.run();
    const id = Number(this.stmts.insMsg.run(0, "⚡전광판", text, now, null).lastInsertRowid);
    this.recentCache = null;
    return { id, name: "⚡전광판", text, at: now, to: null };
  }

  /** trusted = 서버가 만든 문구(공유·티배깅). 말머리 사칭 검사를 건너뛴다 */
  post(userId: number, rawText: string, now = Date.now(), trusted = false): ChatMsg {
    const user = this.stmts.selUser.get(userId) as { name: string; banned: number } | undefined;
    if (!user) throw new ChatError("참가가 필요합니다.");
    if (user.banned) throw new ChatError("채팅이 정지된 계정입니다.");

    let text = String(rawText ?? "").replace(/\s+/g, " ").trim();
    if (!text || text.length > MAX_CHAT_LEN) throw new ChatError(`메시지는 1~${MAX_CHAT_LEN}자여야 합니다.`);

    const prev = this.lastSent.get(userId) ?? 0;
    if (now - prev < COOLDOWN_MS) throw new ChatError("메시지가 너무 빠릅니다. 1초 뒤에 다시 보내세요.");

    let toName: string | null = null;
    const wMatch = /^\/(?:w|ㅈ|귓)\s+(\S+)\s+(.+)$/i.exec(text);
    if (wMatch) {
      const targetRaw = wMatch[1];
      text = wMatch[2].trim();
      const target = this.stmts.selTarget.get(targetRaw) as { name: string } | undefined;
      if (!target) throw new ChatError(`'${targetRaw}' 트레이더를 찾을 수 없습니다.`);
      if (target.name.toLowerCase() === user.name.toLowerCase()) throw new ChatError("자기 자신에게는 귓속말을 보낼 수 없습니다.");
      toName = target.name;
    }

    if (!trusted && RESERVED.some(p => text.startsWith(p))) throw new ChatError("이 말머리는 버튼으로만 쓸 수 있습니다.");

    const compact = text.replace(/[\s._\-*!@#$%^&()]+/g, "").toLowerCase();
    for (const w of BAD_WORDS) {
      if (compact.includes(w)) throw new ChatError("금칙어가 포함되어 있습니다.");
    }

    this.lastSent.set(userId, now);
    const id = Number(this.stmts.insMsg.run(userId, user.name, text, now, toName).lastInsertRowid);
    this.recentCache = null;
    return { id, name: user.name, text, at: now, to: toName };
  }

  /** 전체 최근 메시지 (귓속말은 발신자·수신자에게만 필터링해서 내보낼 수 있게 viewerName 지원) */
  recent(limit = 50, viewerName?: string | null): ChatMsg[] {
    if (!this.recentCache) {
      const rows = this.stmts.selRecent.all(120) as unknown as (Omit<ChatMsg, "reacted"> & { reacted: number })[];
      this.recentCache = rows.reverse().map(r => ({ ...r, reacted: Boolean(r.reacted) }));
    }
    if (!viewerName) return this.recentCache.slice(-limit);
    const whispers = this.stmts.selWhispers.all(viewerName, limit) as unknown as ChatMsg[];
    return [...this.recentCache, ...whispers].sort((a, b) => a.id - b.id).slice(-limit);
  }

  /** 강제청산 알림에 티배깅·묵념. 알림 1건당 처음 누른 한 명만 성공한다 */
  react(userId: number, liqId: number, mode: "teabag" | "rip", now = Date.now()): ChatMsg {
    const sys = this.stmts.selSysMsg.get(liqId) as { text: string } | undefined;
    const m = sys && LIQ_RE.exec(sys.text);
    if (!m) throw new ChatError("강제청산 알림을 찾을 수 없습니다.");
    const [, victim, sym] = m;
    // 쿨타임·밴 검사를 먼저 통과해야 반응 자리를 차지한다 (실패한 시도가 자리를 막지 않게)
    const user = this.stmts.selUser.get(userId) as { name: string; banned: number } | undefined;
    if (!user) throw new ChatError("참가가 필요합니다.");
    if (user.banned) throw new ChatError("채팅이 정지된 계정입니다.");
    if (user.name.toLowerCase() === victim.toLowerCase()) throw new ChatError("본인 청산에는 반응할 수 없습니다.");
    const text = mode === "teabag"
      ? `[티배깅] 🤣 ${victim}님 $${sym} 청산 달달하네요~ 반대 포지션으로 감사히 먹습니다 ㅋㅋ`
      : `[티배깅] 🕯️ ${victim}님의 $${sym} 장렬한 전사를 애도합니다... 성불하세요`;
    if (now - (this.lastSent.get(userId) ?? 0) < COOLDOWN_MS) throw new ChatError("메시지가 너무 빠릅니다. 1초 뒤에 다시 보내세요.");
    if (!this.stmts.insReact.run(liqId, userId, now).changes) throw new ChatError("이미 누군가 반응했습니다.");
    return this.post(userId, text, now, true);
  }

  report(userId: number, msgId: number): { id: number; reports: number; hidden: boolean } {
    const msg = this.stmts.selMsg.get(msgId) as { id: number; user_id: number; hidden: number } | undefined;
    if (!msg) throw new ChatError("메시지를 찾을 수 없습니다.");
    if (msg.user_id === userId) throw new ChatError("본인 메시지는 신고할 수 없습니다.");
    const r = this.stmts.insReport.run(msgId, userId);
    if (!r.changes) throw new ChatError("이미 신고한 메시지입니다.");
    const { c } = this.stmts.cntReport.get(msgId) as { c: number };
    const hidden = Boolean(msg.hidden) || c >= HIDE_REPORTS;
    this.stmts.updReport.run(c, hidden ? 1 : 0, msgId);
    if (hidden) this.recentCache = null;
    return { id: msgId, reports: c, hidden };
  }

  adminList(limit = 100) {
    const rows = this.stmts.selAdmin.all(limit) as { id: number; name: string; text: string; at: number; to: string | null; reports: number; hidden: number }[];
    const banned = (this.stmts.selBanned.all() as { name: string }[]).map(u => u.name);
    return {
      messages: rows.map(r => ({ ...r, hidden: Boolean(r.hidden) })),
      banned,
    };
  }

  setHidden(msgId: number, hidden: boolean) {
    this.stmts.updHidden.run(hidden ? 1 : 0, msgId);
    this.recentCache = null;
  }

  setBan(rawName: string, banned: boolean) {
    const name = String(rawName ?? "").trim();
    const r = this.stmts.updBan.run(banned ? 1 : 0, name);
    if (!r.changes) throw new ChatError("사용자를 찾을 수 없습니다.");
    if (banned) this.stmts.hideUserMsgs.run(name);
    this.recentCache = null;
  }
}
