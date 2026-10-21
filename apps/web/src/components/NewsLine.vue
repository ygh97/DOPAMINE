<script setup lang="ts">
import { computed } from "vue";
import { badgeClass, badgeText, clock } from "../format";
import { useMarket } from "../stores/market";

const m = useMarket();
const latest = computed(() => m.news[0] ?? null);
const openLatest = () => { if (latest.value) m.newsDialog = { mode: "detail", id: latest.value.id }; };
</script>

<template>
  <div class="newsline" aria-live="polite" title="눌러서 자세히 보기" @click="openLatest">
    <span class="live">LIVE</span>
    <template v-if="latest">
      <span :class="badgeClass(latest)">{{ badgeText(latest) }}</span>
      <span class="headline">{{ latest.headline }}</span>
      <time>{{ clock(latest.at) }}</time>
    </template>
    <span v-else class="headline muted">뉴스를 기다리는 중</span>
    <button class="icon-btn" @click.stop="m.newsDialog = { mode: 'list' }">지난 뉴스</button>
  </div>
</template>
