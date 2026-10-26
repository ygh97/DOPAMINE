// 내 계좌 스토어의 채팅 동작: 채팅·수익인증 공유·티배깅, 명예의 전당 한마디, 신고, 운영자 채팅 관리.
import type { AccountCtx } from "./account-types";

async function adminApi<T>(key: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), "x-admin-key": key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `요청 실패 (${r.status})`);
  return data as T;
}

export function socialActions({ api, notify, m }: Pick<AccountCtx, "api" | "notify" | "m">) {
  async function postChat(path: string, body: unknown): Promise<boolean> {
    try {
      const r = await api<{ msg: { id: number; name: string; text: string; at: number } }>(path, body);
      if (!m.chat.some(c => c.id === r.msg.id)) m.chat.push(r.msg);
      return true;
    } catch (e) { notify((e as Error).message, "error"); return false; }
  }
  const sendChat = (text: string) => postChat("/api/chat", { text });
  /** "[공유]" 수익인증. 문구는 서버가 실제 계좌 값으로 만든다 */
  const share = (req: { type: "spot" | "fut" | "fill" | "summary"; sym?: string; id?: number }) => postChat("/api/chat/share", req);
  /** 강제청산 알림에 티배깅·묵념 (알림 1건당 처음 누른 한 명만) */
  async function react(liqId: number, mode: "teabag" | "rip") {
    const ok = await postChat("/api/chat/react", { liqId, mode });
    m.markReacted(liqId); // 성공이든 "이미 누군가 반응"이든 버튼은 내린다
    return ok;
  }

  /** 명예의 전당 TOP 3 본인의 한마디 (50자) */
  async function hallMessage(season: number, text: string) {
    try { await api("/api/hall/message", { season, text }); notify(text ? "명예의 전당에 한마디를 남겼습니다." : "한마디를 지웠습니다."); return true; }
    catch (e) { notify((e as Error).message, "error"); return false; }
  }

  async function reportChat(id: number) {
    try {
      const r = await api<{ id: number; reports: number; hidden: boolean }>("/api/chat/report", { id });
      notify(r.hidden ? "신고 누적으로 메시지가 숨김 처리됐습니다." : `신고가 접수됐습니다 (${r.reports}/3)`);
    } catch (e) { notify((e as Error).message, "error"); }
  }

  const adminChat = (key: string) => adminApi<{ messages: { id: number; name: string; text: string; at: number; reports: number; hidden: boolean }[]; banned: string[] }>(key, "/api/admin/chat");
  const adminBan = (key: string, name: string, banned: boolean) => adminApi(key, "/api/admin/ban", { name, banned });
  const adminHide = (key: string, id: number, hidden: boolean) => adminApi(key, "/api/admin/hide", { id, hidden });

  return { sendChat, share, react, hallMessage, reportChat, adminChat, adminBan, adminHide };
}
