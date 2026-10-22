<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { clock, money, pct } from "../format";
import { useAccount } from "../stores/account";
import { kindBadge, useMarket, type ChatMsg } from "../stores/market";

const m = useMarket();
const a = useAccount();
interface HallRow { season: number; rank: number; name: string; equity: number; returnPct: number; clearedTick: number | null }
const hall = ref<HallRow[]>([]);
const hallSeasons = ref<number[]>([]);
const hallSeason = ref<number | null>(null); // 아래 시즌 탭에서 고른 시즌. 처음엔 가장 최근에 끝난 시즌
const hallRows = computed(() => hall.value.filter(h => h.season === hallSeason.value));
const loadHall = async () => {
  const d: { seasons: number[]; rows: HallRow[] } = await (await fetch("/api/hall")).json();
  hall.value = d.rows; hallSeasons.value = d.seasons;
  if (hallSeason.value == null || !d.seasons.includes(hallSeason.value)) hallSeason.value = d.seasons.at(-1) ?? null;
};

// 애널리스트: 적중률 순 (채점된 리포트가 3건 미만이면 아래로)
const analystRows = computed(() => [...(m.research?.analysts ?? [])].sort((x, y) =>
  Number(y.total >= 3) - Number(x.total >= 3) || y.hits / Math.max(1, y.total) - x.hits / Math.max(1, x.total)));
// 랭킹은 20명까지 보여 주고, 펼치면 전체를 받아 5초마다 갱신한다
const rankOpen = ref(false);
const rankAll = ref<typeof m.ranking | null>(null);
const RANK_TOP = 20;
async function loadRankAll() {
  try { const d = await (await fetch("/api/ranking?limit=500")).json(); rankAll.value = d.rows; } catch { /* 다음에 */ }
}
let rankTimer = 0;
watch([rankOpen, () => m.socialTab], ([open, tab]) => {
  clearInterval(rankTimer);
  if (open && tab === "rank") { void loadRankAll(); rankTimer = window.setInterval(loadRankAll, 5000); }
});
const rankRows = computed(() => (rankOpen.value && rankAll.value ? rankAll.value : m.ranking.slice(0, RANK_TOP)));
const myRank = computed(() => a.me?.rank ?? null);
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

// 알림 보기 (기본 끔): 끄면 전광판(강제청산·졸업·전설)과 티배깅·묵념 메시지를 내 화면 채팅에서만 숨긴다 (브라우저에 저장)
const showSys = ref((() => { try { return localStorage.getItem("dc-chat-sys") === "1"; } catch { return false; } })()); // 기본은 끔
function toggleSys() {
  showSys.value = !showSys.value;
  try { localStorage.setItem("dc-chat-sys", showSys.value ? "1" : "0"); } catch { /* 저장 불가 */ }
  scrollToBottom();
}
const isSys = (c: ChatMsg) => c.name === "⚡전광판" || c.text.startsWith("[티배깅]");
const visibleChat = computed(() => {
  const myName = a.me?.name?.toLowerCase() ?? "";
  return m.chat.filter(c => (showSys.value || !isSys(c)) && (!c.to || (myName && (c.name.toLowerCase() === myName || c.to.toLowerCase() === myName))));
});

const lastMsgId = computed(() => visibleChat.value[visibleChat.value.length - 1]?.id ?? 0);

watch(() => m.socialTab, t => {
  if (t === "hall") void loadHall();
  if (t === "analyst") void m.loadResearch();
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

// 수익인증 문구는 서버가 실제 계좌 값으로 만든다 (화면에서 숫자를 꾸밀 수 없게)
async function shareSummary() {
  if (!a.me) return;
  if (await a.share({ type: "summary" })) scrollToBottom();
}

/** 아직 아무도 반응하지 않은 강제청산 알림이면 true (버튼 표시) */
/** 아직 아무도 반응하지 않은 남의 강제청산 알림이면 true (내 청산에는 버튼을 안 보인다) */
const canReact = (c: ChatMsg) => c.name === "⚡전광판" && c.text.startsWith("[강제청산]") && !c.reacted && !c.text.includes(`💥 ${a.me?.name}님 `);

async function teabag(c: ChatMsg, mode: "mock" | "rip") {
  if (!a.me || !canReact(c)) return;
  if (await a.react(c.id, mode === "mock" ? "teabag" : "rip")) scrollToBottom();
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
  } else if (s.startsWith("[졸업] ")) {
    out.push({ kind: "badge", val: "졸업" });
    s = s.slice(5);
  } else if (s.startsWith("[전설] ")) {
    out.push({ kind: "badge", val: "전설" });
    s = s.slice(5);
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
    <div class="panel-head social-head">
      <div class="tabs social-tabs" role="tablist">
        <button role="tab" data-c="rank" :aria-selected="m.socialTab === 'rank'" @click="m.socialTab = 'rank'">랭킹</button>
        <button v-if="m.mmRanking.length" role="tab" data-c="mm" :aria-selected="m.socialTab === 'mm'" @click="m.socialTab = 'mm'">🏦 세력</button>
        <button v-if="m.whaleRanking.length" role="tab" data-c="whale" :aria-selected="m.socialTab === 'whale'" @click="m.socialTab = 'whale'">🐋 고래</button>
        <button role="tab" data-c="hall" :aria-selected="m.socialTab === 'hall'" @click="m.socialTab = 'hall'">🏆 전당</button>
        <button role="tab" data-c="analyst" :aria-selected="m.socialTab === 'analyst'" @click="m.socialTab = 'analyst'">애널리스트</button>
        <button role="tab" data-c="chat" :aria-selected="m.socialTab === 'chat'" @click="m.socialTab = 'chat'; chatFolded = false">
          채팅
          <span v-if="m.unreadWhispers > 0" class="whisper-tab-badge">🔒{{ m.unreadWhispers }}</span>
        </button>
      </div>
      <button v-if="m.socialTab === 'chat'" class="mini-btn" data-act="chat-sys" :aria-pressed="showSys" title="강제청산·졸업·전설·티배깅 알림을 채팅에서 보이거나 숨깁니다 (내 화면만)" @click="toggleSys">{{ showSys ? "🔔 알림 켬" : "🔕 알림 끔" }}</button>
      <button v-if="m.socialTab === 'chat'" class="mini-btn" data-act="admin-toggle" title="운영자 도구" @click="adminOpen = !adminOpen">관리</button>
    </div>
    <div v-if="m.socialTab === 'rank'" class="table-scroll">
      <div class="rank-hint muted">참가 <b>{{ m.players }}명</b><template v-if="myRank"> · 내 순위 <b>{{ myRank }}위</b></template> · 이름을 누르면 보유 종목·레버리지·<b>청산가</b>를 볼 수 있습니다 🔍</div>
      <table v-if="m.ranking.length" id="ranking" class="grid rank-table">
        <tbody>
          <tr v-for="r in rankRows" :key="r.name" class="rank-row clickable" :class="{ mine: r.name === a.me?.name }" @click="m.spyTarget = r.name">
            <td>{{ r.rank }}</td>
            <td class="rk-name">
              <span v-if="kindBadge(r.kind)" class="kind-badge" :title="r.kind === 'bot' ? '봇' : '세력'">{{ kindBadge(r.kind) }}</span>
              <b>{{ r.name }}</b>
              <span v-if="r.clearedTick" class="stage legend">전설</span>
              <span v-else-if="r.gradTick" class="stage grad">졸업</span>
            </td>
            <td>{{ money(r.equity) }}</td>
            <td :class="r.returnPct >= 0 ? 'up' : 'down'">{{ pct(r.returnPct) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">아직 참가자가 없습니다. 첫 번째로 참가해 보세요.</p>
      <button v-if="m.players > RANK_TOP" id="rankMoreBtn" type="button" class="rank-more" :aria-expanded="rankOpen" @click="rankOpen = !rankOpen">
        {{ rankOpen ? "접기 ▴" : `펼치기 ▾ (전체 ${m.players}명)` }}
      </button>
    </div>
    <div v-else-if="m.socialTab === 'mm'" class="table-scroll">
      <div class="rank-hint muted">🏦 세력: 시장을 움직이고 거래를 채우는 큰손 계정 (봇, $200만으로 시작). 자금 규모가 달라 수익률 순이고 순위·졸업·명예의 전당에서 빠진다</div>
      <table id="mmRanking" class="grid rank-table">
        <tbody>
          <tr v-for="(r, i) in m.mmRanking" :key="r.name" class="rank-row clickable" @click="m.spyTarget = r.name">
            <td>{{ i + 1 }}</td>
            <td class="rk-name"><span class="kind-badge">🏦</span> <b>{{ r.name }}</b></td>
            <td>{{ money(r.equity) }}</td>
            <td :class="r.returnPct >= 0 ? 'up' : 'down'">{{ pct(r.returnPct) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else-if="m.socialTab === 'whale'" class="table-scroll">
      <div class="rank-hint muted">🐋 고래: 큰 자금($200만)으로 가끔 시장을 크게 흔드는 거래자 (봇). 졸업·명예의 전당 제외</div>
      <table id="whaleRanking" class="grid rank-table">
        <tbody>
          <tr v-for="r in m.whaleRanking" :key="r.name" class="rank-row clickable" @click="m.spyTarget = r.name">
            <td><span class="kind-badge">🐋</span></td>
            <td class="rk-name"><b>{{ r.name }}</b></td>
            <td>{{ money(r.equity) }}</td>
            <td :class="r.returnPct >= 0 ? 'up' : 'down'">{{ pct(r.returnPct) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else-if="m.socialTab === 'analyst'" class="table-scroll">
      <div class="rank-hint muted">💡 누구 말이 맞는지는 적중률로 판단하세요. 리포트는 13분 뒤 채점됩니다 (매수: 올랐나 · 매도: 내렸나 · 중립: ±4% 안).</div>
      <div v-if="analystRows.length" id="analysts" class="analyst-list">
        <div v-for="(x, i) in analystRows" :key="x.id" class="analyst-card">
          <div class="analyst-top">
            <span class="analyst-rank">{{ i + 1 }}</span>
            <span class="analyst-name"><b>{{ x.name }}</b> <small class="muted">{{ x.firm }}</small></span>
            <span class="analyst-rate"><b>{{ x.total ? `${Math.round((x.hits / x.total) * 100)}%` : "—" }}</b> <small class="muted">{{ x.hits }}/{{ x.total }}</small></span>
          </div>
          <div class="analyst-bar"><i :style="{ width: x.total ? `${(x.hits / x.total) * 100}%` : '0' }" /></div>
          <div class="analyst-recent">
            <button v-for="r in x.recent.slice(0, 4)" :key="r.id" type="button" class="analyst-chip" :title="`목표가 ${money(r.target)} · 당시 ${money(r.price)}`" @click="m.select(r.sym)">
              {{ r.sym }} <b :class="r.opinion === '매수' ? 'up' : r.opinion === '매도' ? 'down' : 'muted'">{{ r.opinion }}</b>
              {{ r.hit == null ? "⏳" : r.hit ? "✅" : "❌" }}
            </button>
            <span v-if="!x.recent.length" class="muted">아직 리포트 없음</span>
          </div>
        </div>
      </div>
      <p v-else class="empty">리포트를 불러오는 중입니다.</p>
    </div>
    <div v-else-if="m.socialTab === 'hall'" class="hall-wrap">
      <div class="table-scroll">
        <table v-if="hallRows.length" id="hall" class="grid rank-table">
          <tbody>
            <tr v-for="h in hallRows" :key="`${h.season}-${h.name}`" :class="{ mine: h.name === a.me?.name }">
              <td>{{ h.rank <= 3 ? ["🥇", "🥈", "🥉"][h.rank - 1] : `${h.rank}위` }}</td>
              <td class="rk-name"><b>{{ h.name }}</b><span v-if="h.clearedTick" class="stage legend">전설</span></td>
              <td :class="h.returnPct >= 0 ? 'up' : 'down'">{{ pct(h.returnPct) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="empty">{{ hallSeason ? `S${hallSeason}에는 전설이 없습니다.` : "아직 끝난 시즌이 없습니다." }} 시즌 중 100배(총자산 $1,000만)를 달성하면 전설로 여기에 남습니다.</p>
      </div>
      <div v-if="hallSeasons.length" class="tabs hall-seasons" role="tablist" aria-label="시즌">
        <button v-for="sid in hallSeasons" :key="sid" role="tab" :data-hs="sid" :aria-selected="hallSeason === sid" @click="hallSeason = sid">S{{ sid }}</button>
      </div>
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
            <div v-if="a.me && canReact(c)" class="teabag-bar">
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
