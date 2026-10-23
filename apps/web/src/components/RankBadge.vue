<script setup lang="ts">
// 개미 계급 배지: 누적 LP의 계급 개미 위에 실시간 순위 테두리(사람끼리 50위 안·원금 초과)를 겹친다.
// 그림은 assets/ranks의 SVG를 <img>로 쓴다 (그라데이션 id가 배지끼리 겹치지 않게)
import { computed } from "vue";
import { tierOf, type RankFrame } from "@dopamine/engine";

const ICONS = import.meta.glob<string>("../assets/ranks/*.svg", { eager: true, import: "default" });
const icon = (file: string) => ICONS[`../assets/ranks/${file}.svg`] ?? "";
const FRAME_TITLE: Record<RankFrame, string> = { rank1: "실시간 1위", rank2: "실시간 2위", rank3: "실시간 3위", gold: "실시간 4~10위", silver: "실시간 11~30위", bronze: "실시간 31~50위", none: "" };

const props = withDefaults(defineProps<{ lp: number; frame?: RankFrame; size?: number; label?: boolean }>(), { frame: "none", size: 18, label: false });
const tier = computed(() => tierOf(props.lp));
const ant = computed(() => icon(`ant_tier_${String(tier.value.tier).padStart(2, "0")}_${tier.value.id}`));
const ring = computed(() => (props.frame === "none" ? "" : icon(`frame_${props.frame}`)));
const title = computed(() => [`${tier.value.name} · ${props.lp.toLocaleString()} LP`, FRAME_TITLE[props.frame]].filter(Boolean).join(" · "));
</script>

<template>
  <span class="rank-badge" :class="`frame-${frame}`" :style="{ '--rb-size': `${size}px` }" :title="title">
    <span class="rb-icon">
      <img :src="ant" alt="" class="rb-ant" />
      <img v-if="ring" :src="ring" alt="" class="rb-frame" />
    </span>
    <span v-if="label" class="rb-label" :style="{ color: tier.color }">{{ tier.name }}</span>
  </span>
</template>
