<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { clock, money, pct } from "../format";
import { useAccount } from "../stores/account";
import { useMarket, type ChatMsg } from "../stores/market";

const m = useMarket();
const a = useAccount();
interface HallRow { season: number; rank: number; name: string; equity: number; returnPct: number; clearedTick: number | null }
const hall = ref<HallRow[]>([]);
const loadHall = async () => { hall.value = (await (await fetch("/api/hall")).json()).rows; };

const text = ref("");
const whisperTo = ref<string | null>(null);
const chatInputEl = ref<HTMLInputElement | null>(null);
const logEl = ref<HTMLElement | null>(null);

// 맨 아래에 있으면 새 채팅 수신 시 자동으로 맨 아래로 스크롤하고, 위로 올려서 보고 있으면 현재 스크롤 위치를 그대로 고정한다.
const stickBottom = ref(true);
const unreadCount = ref(0);
// 모바일(760px 이하)에서는 채팅을 펼치기/접기로 여닫을 수 있게 지원
const chatFolded = ref(typeof window !== "undefined" && window.innerWidth <= 760);

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 42;
}

function onChatScroll() {
  const el = logEl.value;
  if (!el) return;
  stickBottom.value = isNearBottom(el);
  if (stickBottom.value) unreadCount.value = 0;
}

function scrollToBottom() {
  stickBottom.value = true;
  unreadCount.value = 0;
  void nextTick(() => {
    const el = logEl.value;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      if (logEl.value && stickBottom.value) {
        logEl.value.scrollTop = logEl.value.scrollHeight;
      }
    });
  });
}

const visibleChat = computed(() => {
  const myName = a.me?.name?.toLowerCase() ?? "";
  return m.chat.filter(c => !c.to || (myName && (c.name.toLowerCase() === myName || c.to.toLowerCase() === myName)));
});

const lastMsgId = computed(() => visibleChat.value[visibleChat.value.length - 1]?.id ?? 0);

watch(() => m.socialTab, t => {
  if (t === "hall") void loadHall();
  if (t === "chat") {
    m.unreadWhispers = 0;
    scrollToBottom();
  }
});
watch(() => m.replyWhisperTo, target => {
  if (!target) return;
  whisperTo.value = target;
  m.socialTab = "chat";
  chatFolded.value = false;
  m.unreadWhispers = 0;
  m.replyWhisperTo = null;
  void nextTick(() => chatInputEl.value?.focus());
});
watch(() => m.seasonEpoch, () => { if (m.socialTab === "hall") void loadHall(); });

watch(lastMsgId, (newId, oldId) => {
  if (!newId || newId === oldId) return;
  if (m.socialTab !== "chat") return;
  if (stickBottom.value) {
    scrollToBottom();
  } else {
    unreadCount.value += 1;
  }
});

onMounted(() => {
  if (m.socialTab === "chat") scrollToBottom();
});

function startWhisper(targetName: string) {
  if (!a.me || targetName === "⚡전광판" || targetName === a.me.name) return;
  whisperTo.value = targetName;
  m.socialTab = "chat";
  chatFolded.value = false;
  void nextTick(() => chatInputEl.value?.focus());
}

async function submitChat() {
  const v = text.value.trim();
  if (!v) return;
  const payload = whisperTo.value && !v.startsWith("/") ? `/w ${whisperTo.value} ${v}` : v;
  if (await a.sendChat(payload)) {
    text.value = "";
    scrollToBottom();
  }
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
  if (await a.sendChat(`[공유] 총자산 ${money(a.equity)} (${pct(ret)})${posPart}`)) {
    scrollToBottom();
  }
}

function parseLiqBroadcast(c: ChatMsg): { victim: string; sym: string } | null {
  if (c.name !== "⚡전광판" || !c.text.startsWith("[강제청산]")) return null;
  const match = /💥\s+(\S+)님\s+\$(\S+)/.exec(c.text);
  return match ? { victim: match[1], sym: match[2] } : null;
}

async function teabag(c: ChatMsg, mode: "mock" | "rip") {
  if (!a.me) return;
  const info = parseLiqBroadcast(c);
  if (!info) return;
  const msg = mode === "mock"
    ? `[티배깅] 🤣 ${info.victim}님 $${info.sym} 청산 달달하네요~ 반대 포지션으로 감사히 먹습니다 ㅋㅋ`
    : `[티배깅] 🕯️ ${info.victim}님의 $${info.sym} 장렬한 전사를 애도합니다... 성불하세요 (X키를 눌러 조의를 표하십시오)`;
  if (await a.sendChat(msg)) {
    scrollToBottom();
  }
}

type Token = { kind: "text"; val: string } | { kind: "sym"; sym: string } | { kind: "badge"; val: string; cls?: string };
function tokenize(raw: string): Token[] {
  const out: Token[] = [];
  let s = raw;
  if (s.startsWith("[공유] ")) {
    out.push({ kind: "badge", val: "수익인증" });
    s = s.slice(5);
  } else if (s.startsWith("[티배깅] ")) {
    out.push({ kind: "badge", val: "티배깅", cls: "teabag" });
    s = s.slice(6);
  } else if (s.startsWith("[강제청산] ")) {
    out.push({ kind: "badge", val: "강제청산" });
    s = s.slice(7);
  } else if (s.startsWith("[100배졸업] ")) {
    out.push({ kind: "badge", val: "100배졸업" });
    s = s.slice(9);
  }
  const re = /\$([A-Za-z]{1,10})/g;
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
        <button role="tab" data-c="chat" :aria-selected="m.socialTab === 'chat'" @click="m.socialTab = 'chat'; chatFolded = false">
          채팅
          <span v-if="m.unreadWhispers > 0" class="whisper-tab-badge">🔒{{ m.unreadWhispers }}</span>
        </button>
      </div>
      <span class="muted" style="margin-left: auto">참가 {{ m.players }}명</span>
      <button v-if="m.socialTab === 'chat'" class="mini-btn" data-act="admin-toggle" title="운영자 도구" @click="adminOpen = !adminOpen">관리</button>
    </div>
    <div v-if="m.socialTab === 'rank'" class="table-scroll">
      <div class="rank-hint muted">💡 유저를 클릭하면 보유 종목·레버리지·<b>청산가</b>를 훔쳐보고 저격할 수 있습니다.</div>
      <table v-if="m.ranking.length" id="ranking" class="grid">
        <tbody>
          <tr v-for="r in m.ranking" :key="r.name" class="rank-row clickable" :class="{ mine: r.name === a.me?.name }" @click="m.spyTarget = r.name">
            <td>{{ r.rank }}</td>
            <td>
              <b>{{ r.name }}</b>
              <span v-if="r.clearedTick" class="stage">100배</span>
              <span class="spy-chip">🔍포지션</span>
            </td>
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
    <div v-else class="chat-wrap" :class="{ 'is-folded': chatFolded }">
      <button type="button" class="chat-fold-bar" :aria-expanded="!chatFolded" @click="chatFolded = !chatFolded; if (!chatFolded) scrollToBottom()">
        <span class="chat-fold-title">
          💬 실시간 채팅
          <span v-if="m.unreadWhispers > 0" class="whisper-tab-badge">🔒귓속말 {{ m.unreadWhispers }}</span>
        </span>
        <span v-if="chatFolded && visibleChat.length" class="chat-fold-preview muted">
          <b>{{ visibleChat[visibleChat.length - 1].name }}:</b> {{ visibleChat[visibleChat.length - 1].text }}
        </span>
        <span class="chat-fold-btn">{{ chatFolded ? "펼치기 ▾" : "접기 ▴" }}</span>
      </button>
      <template v-if="!chatFolded">
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

      <div class="chat-log-box">
        <div id="chatLog" ref="logEl" class="chat-log" @scroll.passive="onChatScroll">
          <p v-if="!visibleChat.length" class="msg sys">대화가 없습니다. 닉네임을 누르면 귓속말/포지션 조회를 할 수 있습니다.</p>
          <div
            v-for="c in visibleChat"
            :key="c.id"
            class="chat-card msg"
            :class="{
              'is-mine': c.name === a.me?.name,
              'is-broadcast': c.name === '⚡전광판',
              'is-whisper': !!c.to,
            }"
            :data-msg-id="c.id"
          >
            <div class="chat-card-head">
              <span v-if="c.to" class="whisper-badge">🔒 귓속말 {{ c.name }} → {{ c.to }}</span>
              <button
                v-else
                type="button"
                class="chat-user-btn"
                :class="{ 'mine-name': c.name === a.me?.name }"
                :title="c.name === '⚡전광판' ? '' : '클릭: 포트폴리오 훔쳐보기 / 우클릭: 귓속말'"
                @click="c.name !== '⚡전광판' && (m.spyTarget = c.name)"
                @contextmenu.prevent="startWhisper(c.name)"
              >
                {{ c.name }}
              </button>
              <button
                v-if="a.me && c.name !== '⚡전광판' && c.name !== a.me.name"
                type="button"
                class="whisper-quick-btn"
                title="이 유저에게 귓속말 보내기"
                @click="startWhisper(c.name)"
              >
                귓속말
              </button>
              <small class="muted chat-time">{{ clock(c.at) }}</small>
              <button v-if="a.me && c.name !== a.me.name && c.name !== '⚡전광판'" class="report-btn" data-act="report" title="신고" @click="a.reportChat(c.id)">신고</button>
            </div>
            <div class="chat-card-body">
              <template v-for="(tk, idx) in tokenize(c.text)" :key="idx">
                <span v-if="tk.kind === 'badge'" class="share-badge" :class="tk.cls">{{ tk.val }}</span>
                <button v-else-if="tk.kind === 'sym'" type="button" class="sym-tag" :data-sym="tk.sym" @click="m.select(tk.sym)">${{ tk.sym }}</button>
                <template v-else>{{ tk.val }}</template>
              </template>
            </div>
            <div v-if="a.me && parseLiqBroadcast(c)" class="teabag-bar">
              <button type="button" class="mini-btn teabag-btn" data-act="teabag-mock" @click="teabag(c, 'mock')">🤣 티배깅 조롱</button>
              <button type="button" class="mini-btn teabag-btn" data-act="teabag-rip" @click="teabag(c, 'rip')">🕯️ 묵념 조의</button>
            </div>
          </div>
        </div>
        <button v-if="!stickBottom" type="button" class="chat-jump-btn" @click="scrollToBottom">
          ⬇ {{ unreadCount > 0 ? `새 채팅 ${unreadCount}개 보기` : "맨 아래로 이동" }}
        </button>
      </div>

      <div v-if="whisperTo" class="whisper-target-bar">
        <span>🔒 <b>{{ whisperTo }}</b>님에게 비밀 귓속말 작성 중</span>
        <button type="button" class="mini-btn" @click="whisperTo = null">전체 채팅으로 전환 ✕</button>
      </div>
      <form id="chatForm" class="chat-input" @submit.prevent="submitChat">
        <button id="sharePosBtn" type="button" class="share-btn" :disabled="!a.me" title="내 현재 수익률·포지션 채팅 공유" @click="shareSummary">수익인증</button>
        <input
          ref="chatInputEl"
          v-model="text"
          :disabled="!a.me"
          maxlength="200"
          :placeholder="!a.me ? '참가 후 채팅할 수 있습니다' : whisperTo ? `${whisperTo}님에게 귓속말 입력...` : '메시지 입력 ($NVDA 태그, /w 닉네임 귓속말, 1초 쿨타임)'"
          aria-label="채팅 메시지"
        >
        <button type="submit" :disabled="!a.me || !text.trim()">전송</button>
      </form>
      </template>
    </div>
    <button
      v-if="m.socialTab !== 'chat'"
      type="button"
      class="chat-fold-bar bottom-fold"
      @click="m.socialTab = 'chat'; chatFolded = false; scrollToBottom()"
    >
      <span class="chat-fold-title">
        💬 실시간 채팅
        <span v-if="m.unreadWhispers > 0" class="whisper-tab-badge">🔒귓속말 {{ m.unreadWhispers }}</span>
      </span>
      <span v-if="visibleChat.length" class="chat-fold-preview muted">
        <b>{{ visibleChat[visibleChat.length - 1].name }}:</b> {{ visibleChat[visibleChat.length - 1].text }}
      </span>
      <span class="chat-fold-btn">펼치기 ▾</span>
    </button>
  </div>
</template>
