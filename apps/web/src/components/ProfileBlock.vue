<script setup lang="ts">
// 상단 오른쪽 끝 개미 프로필: 큰 개미(실시간 순위 테두리), 이름·계급·순위, 경험치 바(LP / 다음 계급 LP)와 오늘 예상 LP 미리보기.
// 누르면 프로필 카드(큰 개미, 다음 계급까지, 오늘 예상, 최근 정산, 메달·엠블럼)
import { ANT_TIERS, tierOf } from "@dopamine/engine";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useAccount } from "../stores/account";
import { useMarket } from "../stores/market";
import NameBadges from "./NameBadges.vue";
import RankBadge from "./RankBadge.vue";

const a = useAccount();
const m = useMarket();
const emit = defineEmits<{ guide: [] }>();

const name = computed(() => a.me?.name ?? "");
const lp = computed(() => a.profile?.lp ?? m.badges[name.value]?.lp ?? 0);
const tier = computed(() => tierOf(lp.value));
const next = computed(() => ANT_TIERS[tier.value.tier] ?? null); // tier는 1부터라 다음 계급의 자리
const barMax = computed(() => next.value?.minLp ?? lp.value);
const pctOf = (v: number) => (next.value ? Math.min(100, Math.max(0, ((v - tier.value.minLp) / (barMax.value - tier.value.minLp)) * 100)) : 100);
const delta = computed(() => a.profile?.today.delta ?? 0);
/** 오늘 예상 LP를 바 위에 겹친다: 얻으면 밝은 띠, 잃으면 빨간 띠 */
const preview = computed(() => {
  if (!delta.value || !next.value) return null;
  const from = pctOf(Math.min(lp.value, lp.value + delta.value)), to = pctOf(Math.max(lp.value, lp.value + delta.value));
  return { left: `${from}%`, width: `${Math.max(0, to - from)}%`, gain: delta.value > 0 };
});
const barText = computed(() => (next.value ? `${lp.value.toLocaleString()} / ${barMax.value.toLocaleString()}` : `${lp.value.toLocaleString()} LP`));
const signed = (v: number) => (v > 0 ? `+${v}` : `${v}`);
const REASON: Record<string, string> = { out: "51위 밖", loss: "손실 마감", "late-reset": "23시 이후 다시 시작", dormant: "휴면", absent: "불참" };
const todayText = computed(() => {
  const p = a.profile;
  if (!p) return "";
  if (p.today.reason === "rank") return `지금 ${p.rank}위 → ${signed(p.today.delta)} LP`;
  if (!p.today.delta) return p.today.reason === "absent" ? "오늘 참가 전" : "아직 쉰 날 (거래대금 10% 미만) → 변화 없음";
  return `${REASON[p.today.reason] ?? p.today.reason} → ${signed(p.today.delta)} LP`;
});
const historyText = (h: { rank: number | null; reason: string }) => (h.reason === "rank" ? `${h.rank}위` : REASON[h.reason] ?? h.reason);

const open = ref(false);
const root = ref<HTMLElement | null>(null);
function onDoc(e: MouseEvent) { if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false; }
function onKey(e: KeyboardEvent) { if (e.key === "Escape") open.value = false; }
function toggle() { open.value = !open.value; if (open.value) void a.loadProfile(); }
function guide() { open.value = false; emit("guide"); }

// 순위·오늘 예상은 계속 바뀌니 화면이 보이는 동안 10초마다 다시 받는다
let timer = 0;
onMounted(() => {
  document.addEventListener("mousedown", onDoc);
  document.addEventListener("keydown", onKey);
  void a.loadProfile();
  timer = window.setInterval(() => { if (document.visibilityState === "visible") void a.loadProfile(); }, 10_000);
});
onUnmounted(() => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); clearInterval(timer); });
watch(() => a.me?.name, () => void a.loadProfile());
</script>

<template>
  <div v-if="a.me" id="topUserNick" ref="root" class="profile-block">
    <button type="button" class="pb-head" :aria-expanded="open" title="내 개미 프로필" @click="toggle">
      <RankBadge :lp="lp" :frame="m.frameFor(name)" :size="44" />
      <span class="pb-info">
        <span class="pb-line">
          <b class="pb-name" :style="tier.nameColor ? { color: tier.color } : undefined">{{ name }}</b>
          <span v-if="a.profile?.rank" class="pb-rank">#{{ a.profile.rank }}위</span>
        </span>
        <span class="pb-tier">{{ tier.name }}</span>
        <span class="xp-bar" :class="{ max: !next }">
          <i class="xp-fill" :style="{ width: `${pctOf(lp)}%`, background: tier.color }"></i>
          <i v-if="preview" class="xp-preview" :class="preview.gain ? 'gain' : 'loss'" :style="{ left: preview.left, width: preview.width }"></i>
          <span class="xp-text">{{ barText }}</span>
        </span>
      </span>
    </button>

    <div v-if="open" class="profile-card" role="dialog" aria-label="내 개미 프로필">
      <RankBadge :lp="lp" :frame="m.frameFor(name)" :size="96" />
      <div class="pc-name"><b :style="tier.nameColor ? { color: tier.color } : undefined">{{ name }}</b></div>
      <div class="pc-tier" :style="{ color: tier.color }">{{ tier.tier }}단계 · {{ tier.name }}</div>
      <div v-if="a.profile" class="muted pc-rank">{{ a.profile.rank ? `사람 중 ${a.profile.rank}위 / ${a.profile.people}명` : "오늘 순위 없음" }}</div>
      <span class="xp-bar big" :class="{ max: !next }">
        <i class="xp-fill" :style="{ width: `${pctOf(lp)}%`, background: tier.color }"></i>
        <i v-if="preview" class="xp-preview" :class="preview.gain ? 'gain' : 'loss'" :style="{ left: preview.left, width: preview.width }"></i>
        <span class="xp-text">{{ barText }}</span>
      </span>
      <div class="pc-next">{{ next ? `${next.name}까지 ${(next.minLp - lp).toLocaleString()} LP` : "최고 계급" }}</div>
      <div class="pc-today" :class="delta > 0 ? 'up' : delta < 0 ? 'down' : 'muted'">오늘 예상: {{ todayText }}</div>
      <div v-if="a.profile?.history.length" class="pc-history">
        <span class="muted">최근</span>
        <span v-for="h in a.profile.history" :key="h.season" :class="h.delta > 0 ? 'up' : h.delta < 0 ? 'down' : 'muted'" :title="`S${h.season} ${historyText(h)} → ${h.lp} LP`">{{ signed(h.delta) }}</span>
      </div>
      <NameBadges :name="name" no-rank />
      <button type="button" class="mini-btn pc-guide" @click="guide">📘 LP 가이드</button>
    </div>
  </div>
</template>
