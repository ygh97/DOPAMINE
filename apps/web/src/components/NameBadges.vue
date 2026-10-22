<script setup lang="ts">
// 이름 옆 배지: 시즌 엠블럼(그 시즌 100배 전설)과 TOP 3 메달. 많으면 최근 3개 + "+N"
import { computed } from "vue";
import { useMarket } from "../stores/market";

const props = defineProps<{ name: string }>();
const m = useMarket();
const MEDAL = ["🥇", "🥈", "🥉"];
const b = computed(() => m.badges[props.name]);
const emblems = computed(() => (b.value?.emblems ?? []).slice(-3));
const moreEmblems = computed(() => Math.max(0, (b.value?.emblems.length ?? 0) - 3));
const medals = computed(() => (b.value?.medals ?? []).slice(-2));
const moreMedals = computed(() => Math.max(0, (b.value?.medals.length ?? 0) - 2));
</script>

<template>
  <span v-if="b" class="name-badges">
    <span v-for="e in emblems" :key="'e' + e.season" class="nb-emblem" :title="`S${e.season} 100배 전설`">{{ e.icon }}</span>
    <small v-if="moreEmblems" class="nb-more" :title="`전설 엠블럼 ${b.emblems.length}개`">+{{ moreEmblems }}</small>
    <span v-for="md in medals" :key="'m' + md.season" class="nb-medal" :title="`S${md.season} ${md.rank}등`">{{ MEDAL[md.rank - 1] }}<small>S{{ md.season }}</small></span>
    <small v-if="moreMedals" class="nb-more">+{{ moreMedals }}</small>
  </span>
</template>
