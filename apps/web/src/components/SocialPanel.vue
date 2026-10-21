<script setup lang="ts">
import { ref, watch } from "vue";
import { money, pct } from "../format";
import { useAccount } from "../stores/account";
import { useMarket } from "../stores/market";

const m = useMarket();
const a = useAccount();
const tab = ref<"chat" | "rank" | "hall">("rank");
interface HallRow { season: number; rank: number; name: string; equity: number; returnPct: number; clearedTick: number | null }
const hall = ref<HallRow[]>([]);
const loadHall = async () => { hall.value = (await (await fetch("/api/hall")).json()).rows; };
watch(tab, t => { if (t === "hall") void loadHall(); });
watch(() => m.seasonEpoch, () => { if (tab.value === "hall") void loadHall(); });
</script>

<template>
  <div class="panel" aria-label="채팅과 랭킹">
    <div class="panel-head">
      <div class="tabs" role="tablist">
        <button role="tab" data-c="rank" :aria-selected="tab === 'rank'" @click="tab = 'rank'">랭킹</button>
        <button role="tab" data-c="hall" :aria-selected="tab === 'hall'" @click="tab = 'hall'">명예의 전당</button>
        <button role="tab" data-c="chat" :aria-selected="tab === 'chat'" @click="tab = 'chat'">채팅</button>
      </div>
      <span class="muted" style="margin-left: auto">참가 {{ m.players }}명</span>
    </div>
    <div v-if="tab === 'rank'" class="table-scroll">
      <table v-if="m.ranking.length" id="ranking" class="grid">
        <tbody>
          <tr v-for="r in m.ranking" :key="r.name" class="rank-row" :class="{ mine: r.name === a.me?.name }">
            <td>{{ r.rank }}</td>
            <td><b>{{ r.name }}</b><span v-if="r.clearedTick" class="stage">100배</span></td>
            <td>{{ money(r.equity) }}</td>
            <td :class="r.returnPct >= 0 ? 'up' : 'down'">{{ pct(r.returnPct) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">아직 참가자가 없습니다. 첫 번째로 참가해 보세요.</p>
    </div>
    <div v-else-if="tab === 'hall'" class="table-scroll">
      <table v-if="hall.length" id="hall" class="grid">
        <tbody>
          <tr v-for="h in hall" :key="`${h.season}-${h.name}`" :class="{ mine: h.name === a.me?.name }">
            <td>S{{ h.season }}</td>
            <td>{{ h.rank <= 3 ? ["🥇", "🥈", "🥉"][h.rank - 1] : `${h.rank}위` }}</td>
            <td><b>{{ h.name }}</b><span v-if="h.clearedTick" class="stage">100배</span></td>
            <td :class="h.returnPct >= 0 ? 'up' : 'down'">{{ pct(h.returnPct) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">아직 끝난 시즌이 없습니다. 시즌이 끝나면 1~3위와 100배 달성자가 여기에 남습니다.</p>
    </div>
    <p v-else class="empty">채팅은 준비 중입니다 (M6).</p>
  </div>
</template>
