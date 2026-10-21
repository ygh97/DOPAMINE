<script setup lang="ts">
import { computed, ref } from "vue";
import { badgeClass, badgeText, clock } from "../format";
import { useMarket } from "../stores/market";

const m = useMarket();
const expanded = ref(false);
const latest = computed(() => m.news[0] ?? null);
const recent5 = computed(() => m.news.slice(0, 5));
const openDetail = (id: string) => { m.newsDialog = { mode: "detail", id }; };
const openLatest = () => { if (latest.value) openDetail(latest.value.id); };
</script>

<template>
  <div class="newsline-wrap">
    <div class="newsline" aria-live="polite" title="눌러서 자세히 보기" @click="openLatest">
      <span class="live">LIVE</span>
      <template v-if="latest">
        <span :class="badgeClass(latest)">{{ badgeText(latest) }}</span>
        <span class="headline">{{ latest.headline }}</span>
        <time>{{ clock(latest.at) }}</time>
      </template>
      <span v-else class="headline muted">뉴스를 기다리는 중</span>
      <button id="newsExpandBtn" type="button" class="icon-btn" :aria-expanded="expanded" @click.stop="expanded = !expanded">
        {{ expanded ? "접기 ▴" : "최근 5개 펼치기 ▾" }}
      </button>
      <button type="button" class="icon-btn" @click.stop="m.newsDialog = { mode: 'list' }">전체 뉴스</button>
    </div>
    <ul v-if="expanded" id="newsRecent5" class="news-recent5">
      <li v-for="(n, idx) in recent5" :key="n.id" class="recent5-item" @click="openDetail(n.id)">
        <span class="recent5-idx">{{ idx + 1 }}</span>
        <span :class="badgeClass(n)">{{ badgeText(n) }}</span>
        <span class="recent5-title">{{ n.headline }}</span>
        <span v-if="n.symbols.length" class="recent5-syms">
          <button v-for="s in n.symbols" :key="s" type="button" class="sym-tag" @click.stop="m.select(s)">${{ s }}</button>
        </span>
        <time class="muted">{{ clock(n.at) }}</time>
      </li>
      <li v-if="!recent5.length" class="recent5-empty muted">아직 도착한 뉴스가 없습니다.</li>
    </ul>
  </div>
</template>
