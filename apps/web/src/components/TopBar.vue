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
const ret = computed(() => (a.equity / START - 1) * 100);
// 시즌 남은 시간 (tick마다 다시 계산)
const left = computed(() => {
  void m.tick;
  const ms = (m.season?.endsAt ?? 0) - Date.now();
  if (ms <= 0) return "시즌 마감 중";
  const h = Math.floor(ms / 3_600_000), d = Math.floor(h / 24), min = Math.floor((ms % 3_600_000) / 60_000);
  return d ? `${d}일 ${h % 24}시간 남음` : h ? `${h}시간 ${min}분 남음` : `${min}분 ${Math.floor((ms % 60_000) / 1000)}초 남음`;
});
const goalPct = computed(() => Math.min(100, (a.equity / (a.me?.goal ?? 1e7)) * 100));

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
    <span class="conn" :class="{ on: m.connected }">{{ m.connected ? "실시간" : "재연결 중" }}</span>

    <div v-if="a.me" class="account">
      <div class="kv"><span>{{ a.me.name }}</span><b>{{ a.me.rank ? `${a.me.rank}위` : "-" }}</b></div>
      <div class="kv"><span>총자산</span><b id="equity">{{ money(a.equity) }}</b></div>
      <div class="kv"><span>수익률</span><b :class="ret >= 0 ? 'up' : 'down'">{{ pct(ret) }}</b></div>
      <div class="kv"><span>예수금</span><b>{{ money(a.me.cash) }}</b></div>
      <div class="kv goal"><span>100배 목표 · {{ goalPct.toFixed(2) }}%</span><div class="bar"><i :style="{ width: `${goalPct}%` }"></i></div></div>
      <button class="icon-btn" title="계좌를 $100,000으로 다시 시작" @click="restart">다시 시작</button>
      <button class="icon-btn" @click="a.logout()">나가기</button>
      <button class="icon-btn" @click="ui.toggleTheme()">{{ ui.theme === "dark" ? "라이트" : "다크" }}</button>
    </div>
    <form v-else class="account join" @submit.prevent="submit">
      <span class="muted join-hint">$100,000 → $10,000,000 · 100배 도전</span>
      <input v-model="name" name="name" placeholder="이름 (2~12자)" maxlength="12" autocomplete="username" required>
      <input v-model="password" name="password" type="password" placeholder="비밀번호 6자 이상" minlength="6" maxlength="64" autocomplete="current-password" required>
      <button class="join-btn" :disabled="a.busy">참가하기</button>
      <button type="button" class="icon-btn" @click="ui.toggleTheme()">{{ ui.theme === "dark" ? "라이트" : "다크" }}</button>
    </form>
  </header>
</template>
