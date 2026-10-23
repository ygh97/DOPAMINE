<script setup lang="ts">
// 상단 [📝 업데이트 vX.Y.Z] 버튼과 버전별 업데이트 내역 창. 새 버전을 아직 안 봤으면 버튼이 깜빡인다 (이 브라우저에 기억)
import { ref } from "vue";
import { CURRENT_VERSION, RELEASES } from "../changelog";

const dlg = ref<HTMLDialogElement | null>(null);
const seen = ref((() => { try { return localStorage.getItem("dc-updates-seen") === CURRENT_VERSION; } catch { return false; } })());
function open() {
  dlg.value?.showModal();
  seen.value = true;
  try { localStorage.setItem("dc-updates-seen", CURRENT_VERSION); } catch { /* 저장 못 해도 이번엔 열린다 */ }
}
const close = () => dlg.value?.close();
function onBackdrop(e: MouseEvent) { if (e.target === dlg.value) close(); }
</script>

<template>
  <button id="updatesBtn" type="button" class="icon-btn guide-top-btn updates-btn" :class="{ fresh: !seen }" :title="`업데이트 내역 (현재 v${CURRENT_VERSION})`" @click="open">📝<span class="ub-text"> 업데이트</span></button>
  <dialog id="updatesDlg" ref="dlg" aria-label="업데이트 내역" @click="onBackdrop">
    <div class="dlg-head">
      <h2>📝 업데이트 내역 <small class="muted">현재 v{{ CURRENT_VERSION }}</small></h2>
      <div class="dlg-head-actions">
        <button type="button" class="dlg-act-btn close" @click="close">✕ 닫기</button>
      </div>
    </div>
    <div class="guide-grid">
      <section v-for="r in RELEASES" :key="r.version" class="guide-card release">
        <h3><span class="release-ver">v{{ r.version }}</span> {{ r.title }} <small class="muted">{{ r.date }}</small></h3>
        <ul>
          <li v-for="(it, i) in r.items" :key="i">{{ it }}</li>
        </ul>
      </section>
    </div>
  </dialog>
</template>
