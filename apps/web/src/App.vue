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

const policyDlg = ref<HTMLDialogElement | null>(null);
const openPolicy = () => policyDlg.value?.showModal();
const closePolicy = () => policyDlg.value?.close();
function onPolicyBackdrop(e: MouseEvent) {
  if (e.target === policyDlg.value) closePolicy();
}

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
  <p class="footer">
    모든 시세·뉴스·실적은 게임용 허구이며 실제 투자 권유가 아닙니다 · 수수료 0.05% + 슬리피지 0.05% ·
    <button id="policyBtn" class="link-btn" @click="openPolicy">개인정보 처리방침 및 투자 유의 고지</button>
  </p>
  <dialog id="policyDlg" ref="policyDlg" aria-label="개인정보 처리방침 및 투자 유의 고지" @click="onPolicyBackdrop">
    <button class="dlg-close icon-btn" @click="closePolicy">닫기</button>
    <h2>개인정보 처리방침 및 이용 고지</h2>
    <h3>1. 가상 시세 및 투자 유의 고지</h3>
    <p>도파민 센터의 모든 시세, 차트, 뉴스, 기업 실적, 상장·폐지 이벤트는 확률 엔진이 생성한 <b>게임용 허구 데이터</b>입니다. 실제 금융 시장·상장사와 무관하며 어떠한 경우에도 <b>실제 투자 권유나 자문으로 해석될 수 없습니다</b>. 게임 내 자산($)은 현금 가치가 없으며 환전·출금되지 않습니다.</p>
    <h3>2. 수집하는 개인정보 항목 및 목적</h3>
    <ul>
      <li><b>수집 항목</b>: 참가 닉네임, 비밀번호 해시(scrypt 단방향 암호화), 세션 토큰, 접속 IP 주소(가입 속도 제한용), 채팅 메시지·신고 기록, 게임 내 거래·차트 그리기 기록.</li>
      <li><b>이용 목적</b>: 시즌 계좌 식별, 실시간 랭킹·명예의 전당 산정, 다계정·도배 방지, 채팅 모더레이션.</li>
    </ul>
    <h3>3. 보관 기간 및 파기</h3>
    <p>접속 IP 기록은 속도 제한 확인 후 메모리에서 1분 내 자동 소멸합니다. 계정·채팅·시즌 기록은 서비스 운영 기간 동안 보관되며, 운영자에게 계정 삭제를 요청하면 지체 없이 파기합니다.</p>
  </dialog>
  <nav class="mobile-nav" aria-label="모바일 화면 전환">
    <button v-for="t in M_TABS" :key="t.id" :data-mv="t.id" :aria-selected="mView === t.id" @click="mView = t.id">{{ t.label }}</button>
  </nav>
</template>
