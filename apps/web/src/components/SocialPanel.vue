<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { clock, money, pct } from "../format";
import { useAccount } from "../stores/account";
import { useMarket } from "../stores/market";

const m = useMarket();
const a = useAccount();
interface HallRow { season: number; rank: number; name: string; equity: number; returnPct: number; clearedTick: number | null }
const hall = ref<HallRow[]>([]);
const loadHall = async () => { hall.value = (await (await fetch("/api/hall")).json()).rows; };

const text = ref("");
const logEl = ref<HTMLElement | null>(null);
const scrollDown = () => nextTick(() => { if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight; });

watch(() => m.socialTab, t => {
  if (t === "hall") void loadHall();
  if (t === "chat") scrollDown();
});
watch(() => m.seasonEpoch, () => { if (m.socialTab === "hall") void loadHall(); });
watch(() => m.chat.length, () => { if (m.socialTab === "chat") scrollDown(); });

async function submitChat() {
  const v = text.value.trim();
  if (!v) return;
  if (await a.sendChat(v)) text.value = "";
}

async function shareSummary() {
  if (!a.me) return;
  const ret = ((a.equity / 100_000) - 1) * 100;
  const f = a.futures[0];
  const p = a.positions[0];
  const posPart = f
    ? ` · $${f.sym} ${f.lev}x ${f.side === "long" ? "롱" : "숏"} ${pct(f.pnlPct)}`
    : p
      ? ` · $${p.sym} 현물 ${pct(p.pnlPct)}`
      : ` · 관심 $${m.selected}`;
  await a.sendChat(`[공유] 총자산 ${money(a.equity)} (${pct(ret)})${posPart}`);
}

type Token = { kind: "text"; val: string } | { kind: "sym"; sym: string } | { kind: "badge"; val: string };
function tokenize(raw: string): Token[] {
  const out: Token[] = [];
  let s = raw;
  if (s.startsWith("[공유] ")) {
    out.push({ kind: "badge", val: "수익인증" });
    s = s.slice(5);
  } else if (s.startsWith("[강제청산] ")) {
    out.push({ kind: "badge", val: "강제청산" });
    s = s.slice(7);
  } else if (s.startsWith("[100배졸업] ")) {
    out.push({ kind: "badge", val: "100배졸업" });
    s = s.slice(9);
  }
  const re = /\$([A-Za-z]{2,10})/g;
  let last = 0, match: RegExpExecArray | null;
  while ((match = re.exec(s)) !== null) {
    const sym = match[1].toUpperCase();
    if (!m.quotes[sym]) continue;
    if (match.index > last) out.push({ kind: "text", val: s.slice(last, match.index) });
    out.push({ kind: "sym", sym });
    last = match.index + match[0].length;
  }
  if (last < s.length) out.push({ kind: "text", val: s.slice(last) });
  return out;
}

// 운영자 모더레이션 패널
const adminOpen = ref(false);
const adminKey = ref("");
const adminMsgs = ref<{ id: number; name: string; text: string; at: number; reports: number; hidden: boolean }[]>([]);
const adminBanned = ref<string[]>([]);
const banTarget = ref("");

async function loadAdmin() {
  if (!adminKey.value.trim()) return;
  try {
    const r = await a.adminChat(adminKey.value.trim());
    adminMsgs.value = r.messages;
    adminBanned.value = r.banned;
  } catch (e) { a.notify((e as Error).message, "error"); }
}

async function toggleHide(id: number, hidden: boolean) {
  try {
    await a.adminHide(adminKey.value.trim(), id, hidden);
    await loadAdmin();
  } catch (e) { a.notify((e as Error).message, "error"); }
}

async function toggleBan(name: string, banned: boolean) {
  const n = name.trim();
  if (!n) return;
  try {
    await a.adminBan(adminKey.value.trim(), n, banned);
    banTarget.value = "";
    await loadAdmin();
  } catch (e) { a.notify((e as Error).message, "error"); }
}
</script>

<template>
  <div class="panel" aria-label="채팅과 랭킹">
    <div class="panel-head">
      <div class="tabs" role="tablist">
        <button role="tab" data-c="rank" :aria-selected="m.socialTab === 'rank'" @click="m.socialTab = 'rank'">랭킹</button>
        <button role="tab" data-c="hall" :aria-selected="m.socialTab === 'hall'" @click="m.socialTab = 'hall'">명예의 전당</button>
        <button role="tab" data-c="chat" :aria-selected="m.socialTab === 'chat'" @click="m.socialTab = 'chat'">채팅</button>
      </div>
      <span class="muted" style="margin-left: auto">참가 {{ m.players }}명</span>
      <button v-if="m.socialTab === 'chat'" class="mini-btn" data-act="admin-toggle" title="운영자 도구" @click="adminOpen = !adminOpen">관리</button>
    </div>
    <div v-if="m.socialTab === 'rank'" class="table-scroll">
      <table v-if="m.ranking.length" id="ranking" class="grid">
        <tbody>
          <tr v-for="r in m.ranking" :key="r.name" class="rank-row" :class="{ mine: r.name === a.me?.name }">
            <td>{{ r.rank }}</td>
            <td><b>{{ r.name }}</b><span v-if="r.clearedTick" class="stage">100배</span></td>
            <td>{{ money(r.equity) }}</td>
            <td :class="r.returnPct >= 0 ? 'up' : 'down'">{{ pct(r.returnPct) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">아직 참가자가 없습니다. 첫 번째로 참가해 보세요.</p>
    </div>
    <div v-else-if="m.socialTab === 'hall'" class="table-scroll">
      <table v-if="hall.length" id="hall" class="grid">
        <tbody>
          <tr v-for="h in hall" :key="`${h.season}-${h.name}`" :class="{ mine: h.name === a.me?.name }">
            <td>S{{ h.season }}</td>
            <td>{{ h.rank <= 3 ? ["🥇", "🥈", "🥉"][h.rank - 1] : `${h.rank}위` }}</td>
            <td><b>{{ h.name }}</b><span v-if="h.clearedTick" class="stage">100배</span></td>
            <td :class="h.returnPct >= 0 ? 'up' : 'down'">{{ pct(h.returnPct) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">아직 끝난 시즌이 없습니다. 시즌이 끝나면 1~3위와 100배 달성자가 여기에 남습니다.</p>
    </div>
    <div v-else class="chat-wrap">
      <div v-if="adminOpen" id="adminPanel" class="admin-box">
        <div class="admin-row">
          <input v-model="adminKey" type="password" placeholder="운영자 키" aria-label="운영자 키" @keydown.enter="loadAdmin">
          <button class="mini-btn" data-act="admin-load" @click="loadAdmin">조회</button>
          <input v-model="banTarget" placeholder="차단할 닉네임" aria-label="차단할 닉네임" @keydown.enter="toggleBan(banTarget, true)">
          <button class="mini-btn danger" data-act="admin-ban" @click="toggleBan(banTarget, true)">차단</button>
        </div>
        <div v-if="adminBanned.length" class="admin-banned">
          <span class="muted">차단됨:</span>
          <button v-for="b in adminBanned" :key="b" class="mini-btn" :data-unban="b" @click="toggleBan(b, false)">{{ b }} 해제</button>
        </div>
        <div v-if="adminMsgs.length" class="admin-list">
          <div v-for="am in adminMsgs.slice(0, 20)" :key="am.id" class="admin-item" :class="{ muted: am.hidden }">
            <span><b>{{ am.name }}</b>: {{ am.text }} <small v-if="am.reports">({{ am.reports }}신고)</small></span>
            <span>
              <button class="mini-btn" :data-hide-id="am.id" @click="toggleHide(am.id, !am.hidden)">{{ am.hidden ? "복구" : "숨김" }}</button>
              <button class="mini-btn danger" :data-ban-user="am.name" @click="toggleBan(am.name, true)">차단</button>
            </span>
          </div>
        </div>
      </div>
      <div id="chatLog" ref="logEl" class="chat-log">
        <p v-if="!m.chat.length" class="msg sys">대화가 없습니다. $NVDA처럼 종목을 태그하거나 수익률을 공유해 보세요.</p>
        <div v-for="c in m.chat" :key="c.id" class="msg" :class="{ broadcast: c.name === '⚡전광판' }" :data-msg-id="c.id">
          <span class="msg-body">
            <small class="muted msg-time">{{ clock(c.at) }}</small>
            <b :class="{ 'mine-name': c.name === a.me?.name }">{{ c.name }}</b>
            <span class="msg-text">
              <template v-for="(tk, idx) in tokenize(c.text)" :key="idx">
                <span v-if="tk.kind === 'badge'" class="share-badge">{{ tk.val }}</span>
                <button v-else-if="tk.kind === 'sym'" type="button" class="sym-tag" :data-sym="tk.sym" @click="m.select(tk.sym)">${{ tk.sym }}</button>
                <template v-else>{{ tk.val }}</template>
              </template>
            </span>
          </span>
          <button v-if="a.me && c.name !== a.me.name && c.name !== '⚡전광판'" class="report-btn" data-act="report" title="신고" @click="a.reportChat(c.id)">신고</button>
        </div>
      </div>
      <form id="chatForm" class="chat-input" @submit.prevent="submitChat">
        <button id="sharePosBtn" type="button" class="share-btn" :disabled="!a.me" title="내 현재 수익률·포지션 채팅 공유" @click="shareSummary">수익인증</button>
        <input v-model="text" :disabled="!a.me" maxlength="200" :placeholder="a.me ? '메시지 입력 ($NVDA 태그 가능, 3초 쿨타임)' : '참가 후 채팅할 수 있습니다'" aria-label="채팅 메시지">
        <button type="submit" :disabled="!a.me || !text.trim()">전송</button>
      </form>
    </div>
  </div>
</template>
