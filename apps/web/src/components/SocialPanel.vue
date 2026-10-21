<script setup lang="ts">
import { ref } from "vue";
import { money, pct } from "../format";
import { useAccount } from "../stores/account";
import { useMarket } from "../stores/market";

const m = useMarket();
const a = useAccount();
const tab = ref<"chat" | "rank">("rank");
</script>

<template>
  <div class="panel" aria-label="채팅과 랭킹">
    <div class="panel-head">
      <div class="tabs" role="tablist">
        <button role="tab" data-c="rank" :aria-selected="tab === 'rank'" @click="tab = 'rank'">랭킹</button>
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
    <p v-else class="empty">채팅은 준비 중입니다 (M6).</p>
  </div>
</template>
