<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import CalendarDialog from "./components/CalendarDialog.vue";
import FloatingNews from "./components/FloatingNews.vue";
import HoldingsPanel from "./components/HoldingsPanel.vue";
import NewsDialog from "./components/NewsDialog.vue";
import NewsLine from "./components/NewsLine.vue";
import OrderBook from "./components/OrderBook.vue";
import OrderPanel from "./components/OrderPanel.vue";
import PriceChart from "./components/PriceChart.vue";
import QuoteHeader from "./components/QuoteHeader.vue";
import SocialPanel from "./components/SocialPanel.vue";
import ToastMessage from "./components/ToastMessage.vue";
import TopBar from "./components/TopBar.vue";
import Watchlist from "./components/Watchlist.vue";
import { money, pct } from "./format";
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

const signClass = (v: number) => (v > 0 ? "up" : v < 0 ? "down" : "muted");
const qtyText = (sym: string, q: number) => (m.quotes[sym]?.market === "coin" || !Number.isInteger(q) ? +q.toFixed(6) : q.toLocaleString());

const policyDlg = ref<HTMLDialogElement | null>(null);
const openPolicy = () => policyDlg.value?.showModal();
const closePolicy = () => policyDlg.value?.close();
function onPolicyBackdrop(e: MouseEvent) {
  if (e.target === policyDlg.value) closePolicy();
}

const guideDlg = ref<HTMLDialogElement | null>(null);
const closeGuide = () => { m.guideOpen = false; guideDlg.value?.close(); };
function onGuideBackdrop(e: MouseEvent) {
  if (e.target === guideDlg.value) closeGuide();
}
watch(() => m.guideOpen, (v) => {
  if (v) guideDlg.value?.showModal();
  else guideDlg.value?.close();
});

export interface SpyPortfolio {
  name: string;
  season: number;
  cash: number;
  equity: number;
  returnPct: number;
  rank: number;
  positions: { sym: string; qty: number; avg: number; price: number; pnl: number; pnlPct: number }[];
  futures: { id: number; sym: string; side: "long" | "short"; lev: number; qty: number; entry: number; price: number; liq: number; margin: number; pnl: number; pnlPct: number }[];
}

const spyDlg = ref<HTMLDialogElement | null>(null);
const spyData = ref<SpyPortfolio | null>(null);
const spyLoading = ref(false);
const spyErr = ref("");

async function fetchSpy(name: string) {
  spyLoading.value = true;
  spyErr.value = "";
  try {
    const r = await fetch(`/api/portfolio?name=${encodeURIComponent(name)}`);
    const j = await r.json();
    if (!r.ok) { spyErr.value = j.error ?? "포트폴리오 조회 실패"; spyData.value = null; return; }
    spyData.value = j as SpyPortfolio;
  } catch {
    spyErr.value = "네트워크 오류";
  } finally {
    spyLoading.value = false;
  }
}

const closeSpy = () => { m.spyTarget = null; spyDlg.value?.close(); };
function onSpyBackdrop(e: MouseEvent) {
  if (e.target === spyDlg.value) closeSpy();
}

watch(() => m.spyTarget, (name) => {
  if (name) {
    spyDlg.value?.showModal();
    void fetchSpy(name);
  } else {
    spyDlg.value?.close();
    spyData.value = null;
  }
});

function snipePosition(sym: string, mode: "spot" | "fut", side: "buy" | "sell", lev = 5) {
  m.snipe(sym, mode, side, lev);
  closeSpy();
  if (mView.value !== "all") mView.value = "trade";
}


/** 포지션 스캔 창에서 그 사람에게 귓속말: 창을 닫고 채팅을 귓속말 모드로 연다 */
function whisperFromSpy(name: string) {
  closeSpy();
  replyWhisper(name);
}

function replyWhisper(from: string) {
  m.replyWhisperTo = from;
  m.whisperAlert = null;
  if (mView.value !== "all") mView.value = "social";
}

watch(() => m.selected, () => { if (mView.value === "watch") mView.value = "trade"; });
onMounted(() => {
  m.connect(); void a.refresh(); // 연결되면 스냅샷부터 받는다
  // 화면을 보고 있는 동안 1분마다 계좌를 새로 받는다. 서버는 이것을 "활동 중"으로 세서 🤖 봇 수를 맞춘다
  window.setInterval(() => { if (a.me && document.visibilityState === "visible") void a.refresh(); }, 60_000);
});
</script>

<template>
  <TopBar />
  <div v-if="m.whisperAlert" id="whisperAlertBanner" class="whisper-alert" role="alert">
    <span class="whisper-alert-badge">🔒 귓속말 도착</span>
    <button type="button" class="whisper-name-btn" title="클릭: 포트폴리오 훔쳐보기" @click="m.spyTarget = m.whisperAlert.from">@{{ m.whisperAlert.from }}</button>
    <span class="whisper-alert-text">{{ m.whisperAlert.text }}</span>
    <div class="whisper-alert-actions">
      <button type="button" class="whisper-reply-btn" @click="replyWhisper(m.whisperAlert.from)">답장하기</button>
      <button type="button" class="whisper-close-btn" @click="m.whisperAlert = null">✕</button>
    </div>
  </div>
  <NewsLine />
  <FloatingNews />
  <NewsDialog />
  <CalendarDialog />
  <ToastMessage />
  <main class="layout" :data-mview="mView">
    <Watchlist class="sec-watch" />
    <section class="center">
      <QuoteHeader class="sec-quote" />
      <PriceChart class="sec-chart" />
      <HoldingsPanel class="sec-hold" />
    </section>
    <section class="right">
      <div class="trade-box sec-order">
        <OrderBook />
        <OrderPanel />
      </div>
      <SocialPanel class="sec-social" />
    </section>
  </main>
  <p class="footer">
    모든 시세·뉴스·실적은 게임용 허구이며 실제 투자 권유가 아닙니다 · 시장가 수수료 0.05% · 지정가 체결 수수료 0 ·
    <button id="policyBtn" class="link-btn" @click="openPolicy">개인정보 처리방침 및 투자 유의 고지</button>
  </p>

  <!-- 타인 포트폴리오 훔쳐보기 & 반대 포지션 저격 모달 -->
  <dialog id="spyDlg" ref="spyDlg" aria-label="트레이더 포트폴리오 스캔" @click="onSpyBackdrop">
    <div class="dlg-head">
      <h2>🎯 트레이더 포지션 스캔 <span v-if="spyData" class="spy-name">@{{ spyData.name }}</span></h2>
      <div class="dlg-head-actions">
        <button v-if="spyData && a.me && spyData.name.toLowerCase() !== a.me.name.toLowerCase()" type="button" class="dlg-act-btn" data-act="spy-whisper" @click="whisperFromSpy(spyData.name)">💬 귓속말</button>
        <button v-if="m.spyTarget" type="button" class="dlg-act-btn" @click="fetchSpy(m.spyTarget!)">🔄 새로고침</button>
        <button type="button" class="dlg-act-btn close" @click="closeSpy">✕ 닫기</button>
      </div>
    </div>
    <p v-if="spyLoading" class="empty">포트폴리오 스캔 중…</p>
    <p v-else-if="spyErr" class="empty down">{{ spyErr }}</p>
    <div v-else-if="spyData" class="spy-body">
      <div class="spy-summary">
        <div class="spy-stat">
          <span>시즌 순위</span>
          <b>#{{ spyData.rank }}위</b>
        </div>
        <div class="spy-stat">
          <span>총 평가자산</span>
          <b>{{ money(spyData.equity) }}</b>
        </div>
        <div class="spy-stat">
          <span>시즌 수익률</span>
          <b :class="signClass(spyData.returnPct)">{{ pct(spyData.returnPct) }}</b>
        </div>
        <div class="spy-stat">
          <span>보유 현금(실탄)</span>
          <b>{{ money(spyData.cash) }}</b>
        </div>
      </div>

      <div class="spy-sections">
        <!-- 선물 레버리지 포지션 구역 (div 분리) -->
        <div class="spy-section fut-section">
          <div class="spy-sec-head">
            <div class="spy-sec-title">
              <span class="spy-sec-badge fut">선물 레버리지</span>
              <b>보유 포지션 ({{ spyData.futures.length }})</b>
            </div>
            <span class="spy-sub">강제청산가 근처 종목을 반대 포지션으로 타격해 보세요</span>
          </div>

          <div v-if="!spyData.futures.length" class="spy-empty-box">보유 중인 선물 레버리지 포지션이 없습니다</div>
          <div v-else class="spy-card-list">
            <div v-for="f in spyData.futures" :key="f.id" class="spy-pos-card" :class="f.side">
              <div class="spy-pos-top">
                <div class="spy-pos-sym">
                  <b>{{ f.sym }}</b>
                  <span class="spy-side-tag" :class="f.side">{{ f.lev }}x {{ f.side === "long" ? "롱 (LONG)" : "숏 (SHORT)" }}</span>
                </div>
                <button
                  type="button"
                  class="snipe-btn"
                  :class="f.side === 'long' ? 'short' : 'long'"
                  @click="snipePosition(f.sym, 'fut', f.side === 'long' ? 'sell' : 'buy', f.lev)"
                >
                  🎯 {{ f.side === "long" ? `${f.lev}x 숏 저격` : `${f.lev}x 롱 저격` }}
                </button>
              </div>
              <div class="spy-pos-metrics">
                <div class="spy-metric">
                  <span>진입가</span>
                  <b>{{ money(f.entry) }}</b>
                </div>
                <div class="spy-metric">
                  <span>현재가</span>
                  <b>{{ money(m.quotes[f.sym]?.price ?? f.price) }}</b>
                </div>
                <div class="spy-metric liq">
                  <span>💀 강제청산가</span>
                  <b class="liq-price">{{ money(f.liq) }}</b>
                </div>
                <div class="spy-metric">
                  <span>증거금</span>
                  <b>{{ money(f.margin) }}</b>
                </div>
                <div class="spy-metric pnl">
                  <span>미실현 손익</span>
                  <b :class="signClass(f.pnl)">{{ money(f.pnl) }} ({{ pct(f.pnlPct) }})</b>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 현물 보유 종목 구역 (div 분리) -->
        <div class="spy-section spot-section">
          <div class="spy-sec-head">
            <div class="spy-sec-title">
              <span class="spy-sec-badge spot">현물 보유</span>
              <b>보유 종목 ({{ spyData.positions.length }})</b>
            </div>
            <span class="spy-sub">현물 대량 보유 종목을 선물 숏으로 타격할 수 있습니다</span>
          </div>

          <div v-if="!spyData.positions.length" class="spy-empty-box">보유 중인 현물 종목이 없습니다</div>
          <div v-else class="spy-card-list">
            <div v-for="p in spyData.positions" :key="p.sym" class="spy-pos-card spot">
              <div class="spy-pos-top">
                <div class="spy-pos-sym">
                  <b>{{ p.sym }}</b>
                  <span class="spy-side-tag spot">현물 {{ qtyText(p.sym, p.qty) }}주/개</span>
                </div>
                <button
                  type="button"
                  class="snipe-btn short"
                  @click="snipePosition(p.sym, 'fut', 'sell', 5)"
                >
                  🎯 5x 숏 타격
                </button>
              </div>
              <div class="spy-pos-metrics spot-metrics">
                <div class="spy-metric">
                  <span>보유 수량</span>
                  <b>{{ qtyText(p.sym, p.qty) }}</b>
                </div>
                <div class="spy-metric">
                  <span>평균 단가</span>
                  <b>{{ money(p.avg) }}</b>
                </div>
                <div class="spy-metric">
                  <span>현재가</span>
                  <b>{{ money(m.quotes[p.sym]?.price ?? p.price) }}</b>
                </div>
                <div class="spy-metric pnl">
                  <span>평가 손익</span>
                  <b :class="signClass(p.pnl)">{{ money(p.pnl) }} ({{ pct(p.pnlPct) }})</b>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </dialog>

  <!-- 뉴비 가이드 모달 -->
  <dialog id="guideDlg" ref="guideDlg" aria-label="도파민 센터 뉴비 생존 가이드" @click="onGuideBackdrop">
    <div class="dlg-head">
      <h2>🔥 도파민 센터 뉴비 생존 &amp; 사냥 가이드</h2>
      <div class="dlg-head-actions">
        <button type="button" class="dlg-act-btn close" @click="closeGuide">✕ 닫기</button>
      </div>
    </div>
    <div class="guide-grid">
      <div class="guide-card">
        <h3>0. 처음이면 이것만</h3>
        <p>① 위쪽에 <b>닉네임 + 비밀번호</b>를 넣고 <b>[참가하기]</b> (이메일 없음, 처음 쓰는 이름이면 바로 가입). ② 왼쪽 목록에서 종목을 누릅니다. ③ 주문 패널에서 <b>매수</b>, 비중 <b>10%</b>를 고르고 주문. ④ 아래 <b>보유종목</b> 탭에서 손익을 보고, 오르면 <b>매도</b>. 익숙해지면 선물과 지정가로 넘어가세요.</p>
      </div>
      <div class="guide-card">
        <h3>1. 목표와 시즌</h3>
        <p><b>$100,000</b>으로 시작해 50배($500만)면 <b>졸업</b>, 100배($1,000만)면 <b>전설</b>. 전설은 100배를 <b>지키는 동안만</b>이고, 시즌이 끝날 때 100배 이상이어야 <b>명예의 전당</b>에 오릅니다. 시즌은 <b>매일 00:00~23:58</b>(게임 속 1년)이고, 2분 쉰 뒤 모두 $100,000로 새로 시작합니다. 시즌 최종 1~3등은 <b>TOP 3 메달</b>, 전설은 <b>시즌 엠블럼</b>이 이름 옆에 영구로 붙습니다. 다 잃으면 상단 <b>[다시 시작]</b> (직후 10분은 5배까지만).</p>
      </div>
      <div class="guide-card">
        <h3>2. 종목: 주식 · 코인 · 신흥주</h3>
        <p>미국 대형주 20개, 코인 5개, 가상 신흥주 10개 (모두 <b>가상 시세</b>). 신흥주는 <b>기술 검증 3단계</b>(최초 보도 → 추가 확인 → 확인/정정)에 따라 폭등하거나 폭락하고, 잘 크면 주식으로 <b>승격</b>, 시총이 너무 작아지면 관리종목 → 상장폐지됩니다. 폐지되면 마지막 가격으로 정산됩니다.</p>
      </div>
      <div class="guide-card">
        <h3>3. 주문: 호가창 · 시장가 · 지정가</h3>
        <p>모든 주문은 다른 사람·봇과 같은 <b>호가창</b>에서 체결됩니다. <b>시장가</b>는 바로 체결(수수료 0.05%)되고, 큰 주문일수록 여러 호가를 먹어 더 비싸게 삽니다. <b>지정가</b>는 원하는 가격에 걸어 두는 주문으로, 걸린 채 체결되면 수수료 0이고 그동안 돈이 묶입니다(최대 20개, 시즌 끝까지). 호가창 가격을 누르면 그 가격이 지정가에 들어갑니다. 주문은 1초에 2건까지, 내 체결은 차트에 <b>B/S</b>로 찍힙니다.</p>
      </div>
      <div class="guide-card">
        <h3>4. 선물: 롱 · 숏 · 최대 10배</h3>
        <p>주식·코인·신흥주 모두 <b>2·3·5·10배</b>. 증거금의 <b>90%</b>를 잃는 가격에서 <b>강제청산</b>되고, 청산 주문이 다시 가격을 밀어 연쇄 청산이 나기도 합니다. 같은 종목·방향·배율로 더 사면 한 포지션으로 합쳐집니다(물타기). 선물 포지션 탭에서 <b>익절·손절</b>을 걸어 두세요. 차트의 진입가·청산가·지정가 선은 <b>⚙️ 설정</b>에서 켜고 끕니다.</p>
      </div>
      <div class="guide-card">
        <h3>5. 뉴스: LIVE · 📅 일정 · 루머</h3>
        <p>상단 <b>LIVE</b> 바에 뉴스가 계속 나옵니다(<b>최근 5개 펼치기</b>, <b>🪟 실시간 뉴스창</b>으로 띄워 두기). <b>📅 일정</b>에는 지표·실적·행사·ETF 심사 발표 시각이 미리 올라오고 결과는 발표 때 나옵니다. <b>[루머]</b>는 나중에 확인되거나 부인되고, 한 회사 소식이 관련주로 번지기도 합니다(<b>[연쇄]</b>). 뉴스 첫 반응 뒤에 끝까지 가는 건 절반 남짓이라, 늦게 따라 타면 되돌림을 맞을 수 있어요.</p>
      </div>
      <div class="guide-card">
        <h3>6. 큰손이 되면: 시세를 움직이기</h3>
        <p>호가창이 진짜라서 큰돈이 들어가면 가격이 밀리고, 그 매수·매도가 시세에 남습니다. <b>시총이 작은 신흥주</b>일수록 잘 움직입니다. 대신 한 종목은 가상 유동성의 <b>20%</b>까지만 들 수 있고, 🏦 세력·🐋 고래도 똑같이 할 수 있습니다. 펌핑하다가 물리는 것도 게임입니다.</p>
      </div>
      <div class="guide-card">
        <h3>7. 애널리스트: 누구 말을 믿을까</h3>
        <p>가상 애널리스트 5명이 <b>매수·중립·매도</b> 리포트를 냅니다. 리포트는 13분 뒤 맞았는지 채점되고, 랭킹 옆 <b>애널리스트</b> 탭에서 적중률을 볼 수 있습니다. 성향은 비밀입니다. 잘 맞히는 사람도, <b>반대로 해야 맞는 사람</b>도 있습니다. 종목 헤더에는 의견 분포와 평균 목표가가 나옵니다.</p>
      </div>
      <div class="guide-card">
        <h3>8. 🤖 봇 · 🏦 세력 · 🐋 고래 · 🎯 저격</h3>
        <p>랭킹의 🤖 봇은 사람과 같이 거래하는 참가자입니다(사람이 들어오면 그만큼 쉽니다). <b>🏦 세력</b> 20개는 전략을 계속 바꾸는 큰손, <b>🐋 고래</b> 10마리는 큰 주문으로 시장을 흔듭니다. 랭킹·채팅에서 이름을 누르면 그 사람의 보유 종목과 <b>진입가·청산가</b>가 보이고, <b>[🎯 저격]</b>으로 반대 포지션을 잡거나 <b>[💬 귓속말]</b>을 보낼 수 있습니다. 누가 청산되면 처음 누른 한 명만 <b>[🤣 티배깅]</b> 또는 <b>[🕯️ 묵념]</b>.</p>
      </div>
      <div class="guide-card">
        <h3>9. 채팅 · 단축키 · 팁</h3>
        <p><code>/w 닉네임 내용</code>은 귓속말(오면 알림음), <code>/r 내용</code>은 마지막으로 나에게 귓속말한 사람에게 답장. 채팅의 청산·졸업 알림은 기본으로 꺼져 있고 <b>🔔 알림</b>으로 켭니다. 보유 종목의 <b>[자랑]</b>은 서버가 실제 계좌로 만든 수익 인증입니다. 단축키: <b>B</b> 매수/롱, <b>S</b> 매도/숏, <b>1~4</b> 비중 10~100%. 보고 있는 종목을 다시 누르면 차트가 최신 봉으로 갑니다. 서버가 잠깐 꺼져 있던 동안은 시세도 멈춰 있습니다.</p>
      </div>
    </div>
  </dialog>

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
