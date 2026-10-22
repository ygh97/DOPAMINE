<script setup lang="ts">
// 📅 일정: 예고된 지표 발표·실적·신제품 행사·ETF 심사. 결과는 서버도 미리 알려 주지 않는다
import { computed, ref, watch } from "vue";
import { useMarket } from "../stores/market";

const m = useMarket();
const dlg = ref<HTMLDialogElement | null>(null);
watch(() => m.calendarOpen, open => {
  if (open) { void m.loadResearch(); dlg.value?.showModal(); }
  else dlg.value?.close();
});
const close = () => { m.calendarOpen = false; };
const items = computed(() => (m.research?.upcoming ?? []).filter(u => u.at > m.tick).slice(0, 30));
/** 남은 시간 (1 tick = 1초) */
function left(at: number) {
  const s = Math.max(0, at - m.tick), h = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}시간 ${mm}분` : mm ? `${mm}분 ${String(ss).padStart(2, "0")}초` : `${ss}초`;
}
function go(sym: string) { m.select(sym); close(); }
</script>

<template>
  <dialog id="calendarDlg" ref="dlg" aria-label="일정" @close="close" @click="e => e.target === dlg && close()">
    <div class="dlg-head">
      <h2>📅 다가오는 일정</h2>
      <div class="dlg-head-actions"><button type="button" class="dlg-act-btn close" @click="close">✕ 닫기</button></div>
    </div>
    <p class="muted cal-note">예고된 발표만 보입니다. 결과는 발표 때 뉴스로 나옵니다.</p>
    <ul v-if="items.length" class="cal-list">
      <li v-for="u in items" :key="`${u.at}-${u.title}`">
        <span class="cal-left" :class="{ soon: u.at - m.tick < 120 }">{{ left(u.at) }} 뒤</span>
        <span class="cal-title">{{ u.title }}</span>
        <button v-for="s in u.symbols" :key="s" type="button" class="sym-tag news-sym-tag" @click="go(s)">${{ s }}</button>
      </li>
    </ul>
    <p v-else class="empty">예고된 일정이 없습니다.</p>
  </dialog>
</template>
