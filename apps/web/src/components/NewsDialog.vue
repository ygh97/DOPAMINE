<script setup lang="ts">
import type { NewsItem } from "@dopamine/engine";
import { computed, ref, watch } from "vue";
import { badgeClass, badgeText, change, clock, dateText, money, pct } from "../format";
import { useMarket } from "../stores/market";

const m = useMarket();
const dlg = ref<HTMLDialogElement | null>(null);
const page = ref<NewsItem[]>([]);

const detail = computed(() => {
  const d = m.newsDialog;
  if (d?.mode !== "detail") return null;
  return m.news.find(n => n.id === d.id) ?? page.value.find(n => n.id === d.id) ?? null;
});
// 같은 사건의 단계들 (최초 보도 → 추가 확인 → 확인/정정)
const steps = computed(() => {
  const ev = detail.value?.event;
  if (!ev) return [];
  const seen = new Set<string>();
  return [...m.news, ...page.value]
    .filter(x => x.event?.id === ev.id && !seen.has(x.id) && seen.add(x.id))
    .sort((a, b) => a.event!.index - b.event!.index);
});

watch(() => m.newsDialog, async d => {
  if (!d) { if (dlg.value?.open) dlg.value.close(); return; }
  if (!dlg.value?.open) dlg.value?.showModal();
  if (d.mode === "list") page.value = await m.fetchNewsPage();
});

function goChart(sym: string) {
  m.select(sym);
  m.newsDialog = null;
}
function onBackdrop(e: MouseEvent) {
  if (e.target === dlg.value) m.newsDialog = null;
}
</script>

<template>
  <dialog id="newsDlg" ref="dlg" aria-label="뉴스 자세히" @close="m.newsDialog = null" @click="onBackdrop">
    <button class="dlg-close icon-btn" @click="m.newsDialog = null">닫기</button>
    <template v-if="detail">
      <div class="dlg-meta">
        <span :class="badgeClass(detail)">{{ badgeText(detail) }}</span>
        <span class="muted">{{ dateText(detail.date) }} · {{ clock(detail.at) }}</span>
      </div>
      <h2>{{ detail.headline }}</h2>
      <p>{{ detail.body }}</p>
      <template v-if="steps.length">
        <h3>사건 진행</h3>
        <ol class="steps">
          <li v-for="s in steps" :key="s.id" :class="{ now: s.id === detail.id }">
            <b>{{ s.event!.index + 1 }}. {{ s.event!.label }}</b> {{ s.headline.split(" · ").at(-1) }}
          </li>
        </ol>
      </template>
      <template v-if="detail.symbols.length">
        <h3>관련 종목</h3>
        <table class="grid">
          <thead><tr><th>종목</th><th>뉴스 당시</th><th>현재가</th><th>변화</th><th></th></tr></thead>
          <tbody>
            <tr v-for="s in detail.symbols" :key="s">
              <template v-if="m.quotes[s]">
                <td><b>{{ s }}</b> <small class="muted">{{ m.quotes[s].name }}</small></td>
                <td>{{ money(detail.priceAt[s]) }}</td>
                <td>{{ money(m.quotes[s].price) }}</td>
                <td :class="change(m.quotes[s].price, detail.priceAt[s]) >= 0 ? 'up' : 'down'">
                  {{ pct(change(m.quotes[s].price, detail.priceAt[s])) }}
                </td>
                <td><button class="icon-btn" @click="goChart(s)">차트</button></td>
              </template>
              <template v-else>
                <td><b>{{ s }}</b></td>
                <td>{{ detail.priceAt[s] ? money(detail.priceAt[s]) : "-" }}</td>
                <td colspan="3" class="muted">상장폐지</td>
              </template>
            </tr>
          </tbody>
        </table>
      </template>
      <p class="disclaimer">게임용 허구 뉴스입니다. 같은 뉴스라도 가격 반응은 매번 다를 수 있습니다.</p>
    </template>
    <template v-else-if="m.newsDialog?.mode === 'list'">
      <h2>지난 뉴스</h2>
      <ul class="news-list">
        <li v-for="n in (page.length ? page : m.news).slice(0, 100)" :key="n.id">
          <button @click="m.newsDialog = { mode: 'detail', id: n.id }">
            <span :class="badgeClass(n)">{{ badgeText(n) }}</span>
            <span class="t">{{ n.headline }}</span>
            <time>{{ clock(n.at) }}</time>
          </button>
        </li>
      </ul>
    </template>
  </dialog>
</template>
