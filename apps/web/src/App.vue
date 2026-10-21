<script setup lang="ts">
import { onMounted } from "vue";
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
onMounted(() => { m.connect(); void a.refresh(); }); // 연결되면 스냅샷부터 받는다
</script>

<template>
  <TopBar />
  <NewsLine />
  <NewsDialog />
  <ToastMessage />
  <main class="layout">
    <Watchlist />
    <section class="center">
      <QuoteHeader />
      <PriceChart />
      <HoldingsPanel />
    </section>
    <section class="right">
      <OrderPanel />
      <SocialPanel />
    </section>
  </main>
  <p class="footer">모든 시세·뉴스·실적은 게임용 허구이며 실제 투자 정보가 아닙니다 · 수수료 0.05% + 슬리피지 0.05% (진입·종료 각각)</p>
</template>
