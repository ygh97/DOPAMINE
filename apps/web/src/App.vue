<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import HoldingsPanel from "./components/HoldingsPanel.vue";
import NewsDialog from "./components/NewsDialog.vue";
import NewsLine from "./components/NewsLine.vue";
import OrderPanel from "./components/OrderPanel.vue";
import PriceChart from "./components/PriceChart.vue";
import QuoteHeader from "./components/QuoteHeader.vue";
import SocialPanel from "./components/SocialPanel.vue";
import ToastMessage from "./components/ToastMessage.vue";
import TopBar from "./components/TopBar.vue";
import Watchlist from "./components/Watchlist.vue";
import { useAccount } from "./stores/account";
import { useMarket } from "./stores/market";

const m = useMarket();
const a = useAccount();
const mView = ref<"all" | "trade" | "watch" | "hold" | "social">("all");
const M_TABS = [
  { id: "all", label: "전체" },
  { id: "trade", label: "차트·주문" },
  { id: "watch", label: "종목" },
  { id: "hold", label: "포지션" },
  { id: "social", label: "랭킹·채팅" },
] as const;

watch(() => m.selected, () => { if (mView.value === "watch") mView.value = "trade"; });
onMounted(() => { m.connect(); void a.refresh(); }); // 연결되면 스냅샷부터 받는다
</script>

<template>
  <TopBar />
  <NewsLine />
  <NewsDialog />
  <ToastMessage />
  <main class="layout" :data-mview="mView">
    <Watchlist class="sec-watch" />
    <section class="center">
      <QuoteHeader class="sec-quote" />
      <PriceChart class="sec-chart" />
      <HoldingsPanel class="sec-hold" />
    </section>
    <section class="right">
      <OrderPanel class="sec-order" />
      <SocialPanel class="sec-social" />
    </section>
  </main>
  <p class="footer">모든 시세·뉴스·실적은 게임용 허구이며 실제 투자 정보가 아닙니다 · 수수료 0.05% + 슬리피지 0.05% (진입·종료 각각)</p>
  <nav class="mobile-nav" aria-label="모바일 화면 전환">
    <button v-for="t in M_TABS" :key="t.id" :data-mv="t.id" :aria-selected="mView === t.id" @click="mView = t.id">{{ t.label }}</button>
  </nav>
</template>
