<script setup lang="ts">
import { computed, ref } from "vue";
import { dateText, money, pct } from "../format";
import { useAccount } from "../stores/account";
import { useMarket } from "../stores/market";
import { useUi } from "../stores/ui";

const m = useMarket();
const a = useAccount();
const ui = useUi();
const name = ref("");
const password = ref("");

const START = 100_000;
// 뉴비 가이드를 한 번도 안 열었으면 버튼을 채워서 깜빡인다 (이 브라우저에 기억)
const guideSeen = ref((() => { try { return localStorage.getItem("dc-guide-seen") === "1"; } catch { return false; } })());
function openGuide() {
  m.guideOpen = true;
  guideSeen.value = true;
  try { localStorage.setItem("dc-guide-seen", "1"); } catch { /* 저장 못 해도 이번엔 열린다 */ }
}
const ret = computed(() => (a.equity / START - 1) * 100);
// 시즌 남은 시간 (tick마다 다시 계산)
const left = computed(() => {
  void m.tick;
  const now = Date.now();
  if (m.season && now < m.season.startedAt) return `다음 시즌 ${new Date(m.season.startedAt).toTimeString().slice(0, 5)} 시작`;
  const ms = (m.season?.endsAt ?? 0) - now;
  if (ms <= 0) return "시즌 마감 중";
  const h = Math.floor(ms / 3_600_000), d = Math.floor(h / 24), min = Math.floor((ms % 3_600_000) / 60_000);
  return d ? `${d}일 ${h % 24}시간 남음` : h ? `${h}시간 ${min}분 남음` : `${min}분 ${Math.floor((ms % 60_000) / 1000)}초 남음`;
});
// 다음 목표: 20배 졸업 전에는 졸업, 졸업 뒤에는 100배 전설
const nextGoal = computed(() => (a.me?.gradTick == null ? { label: "20배 졸업", value: a.me?.grad ?? 2e6 } : { label: "100배 전설", value: a.me?.goal ?? 1e7 }));
const goalPct = computed(() => Math.min(100, (a.equity / nextGoal.value.value) * 100));

async function submit() {
  await a.join(name.value, password.value);
  if (a.me) password.value = "";
}
function restart() {
  if (confirm("계좌를 $100,000으로 다시 시작할까요? 보유종목이 모두 사라지고 되돌릴 수 없습니다.")) void a.reset();
}
</script>

<template>
  <header class="topbar">
    <div class="logo"><b>도파민 <i>센터</i></b><small>DOPAMINE CENTER</small></div>
    <div class="clock" :title="left">S{{ m.season?.id ?? 1 }} · <b>{{ dateText(m.date) }}</b> <small id="seasonLeft" class="muted">{{ left }}</small></div>
    <span class="conn" :class="{ on: m.connected }" :title="m.connected ? `지금 ${m.viewers}명이 보고 있습니다 (손님 포함, 탭마다 1명)` : undefined">{{ m.connected ? "실시간" : "재연결 중" }}<b v-if="m.connected && m.viewers" id="viewerCount" class="viewers"> · {{ m.viewers }}명 보는 중</b></span>
    <button id="guideBtn" type="button" class="icon-btn guide-top-btn" :class="{ fresh: !guideSeen }" @click="openGuide">📘 뉴비 가이드</button>

    <div v-if="a.me" id="topUserNick" class="top-center-nick">
      <span class="nick-label">트레이더</span>
      <b class="nick-name">{{ a.me.name }}</b>
      <span class="nick-rank">{{ a.me.rank ? `#${a.me.rank}위` : "순위 집계중" }}</span>
    </div>

    <div v-if="a.me" class="account">
      <div class="kv"><span>총자산</span><b id="equity">{{ money(a.equity) }}</b></div>
      <div class="kv"><span>수익률</span><b :class="ret >= 0 ? 'up' : 'down'">{{ pct(ret) }}</b></div>
      <div class="kv"><span>예수금</span><b>{{ money(a.me.cash) }}</b></div>
      <div class="kv goal"><span>{{ nextGoal.label }} · {{ goalPct.toFixed(2) }}%</span><div class="bar"><i :style="{ width: `${goalPct}%` }"></i></div></div>
      <button class="icon-btn" title="계좌를 $100,000으로 다시 시작" @click="restart">다시 시작</button>
      <button class="icon-btn" @click="a.logout()">나가기</button>
      <button class="icon-btn" data-act="theme" @click="ui.toggleTheme()">{{ ui.theme === "dark" ? "라이트" : "다크" }}</button>
    </div>
    <form v-else class="account join" @submit.prevent="submit">
      <span class="muted join-hint">$100,000 → 20배 졸업 · 100배 전설</span>
      <input v-model="name" name="name" placeholder="이름 (2~12자)" maxlength="12" autocomplete="username" required>
      <input v-model="password" name="password" type="password" placeholder="비밀번호 6자 이상" minlength="6" maxlength="64" autocomplete="current-password" required>
      <button class="join-btn" :disabled="a.busy">참가하기</button>
      <button type="button" class="icon-btn" data-act="theme" @click="ui.toggleTheme()">{{ ui.theme === "dark" ? "라이트" : "다크" }}</button>
    </form>
  </header>
</template>
