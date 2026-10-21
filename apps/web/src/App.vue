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

async function sendBannerTeabag(text: string, type: "teabag" | "rip") {
  const m1 = /💥\s+(\S+)님\s+\$(\S+)/.exec(text);
  const tag = type === "teabag"
    ? (m1 ? `[티배깅] 🤣 ${m1[1]}님 $${m1[2]} 청산 달달하네요~ 반대 포지션으로 감사히 먹습니다 ㅋㅋ` : `[티배깅] 🤣 전광판 강제청산 달달하네요 ㅋㅋㅋ`)
    : (m1 ? `[티배깅] 🕯️ ${m1[1]}님의 $${m1[2]} 장렬한 전사를 애도합니다... 성불하세요` : `[티배깅] 🕯️ 전광판 청산자에 깊은 조의를 표합니다`);
  await a.sendChat(tag);
}

watch(() => m.selected, () => { if (mView.value === "watch") mView.value = "trade"; });
onMounted(() => { m.connect(); void a.refresh(); }); // 연결되면 스냅샷부터 받는다
</script>

<template>
  <TopBar />
  <div v-if="m.banner" id="megaphoneBanner" class="megaphone" :class="m.banner.kind" @click="m.banner = null">
    <b>⚡ 실시간 전광판</b>
    <span>{{ m.banner.text }}</span>
    <span v-if="m.banner.kind === 'liq'" class="banner-actions" @click.stop>
      <button type="button" class="teabag-btn" @click="sendBannerTeabag(m.banner.text, 'teabag')">🤣 티배깅 조롱</button>
      <button type="button" class="teabag-btn rip" @click="sendBannerTeabag(m.banner.text, 'rip')">🕯️ 묵념</button>
    </span>
  </div>
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

  <!-- 타인 포트폴리오 훔쳐보기 & 반대 포지션 저격 모달 -->
  <dialog id="spyDlg" ref="spyDlg" aria-label="트레이더 포트폴리오 스캔" @click="onSpyBackdrop">
    <div class="dlg-head">
      <h2>🎯 트레이더 포지션 스캔 <span v-if="spyData" class="spy-name">@{{ spyData.name }}</span></h2>
      <div class="dlg-head-actions">
        <button v-if="m.spyTarget" type="button" class="mini-btn" @click="fetchSpy(m.spyTarget!)">🔄 새로고침</button>
        <button type="button" class="dlg-close icon-btn" @click="closeSpy">닫기</button>
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

      <h3>🔥 선물 레버리지 포지션 ({{ spyData.futures.length }}) <span class="spy-sub">청산가 근처 종목을 반대 포지션으로 타격해 강제청산을 유도하세요!</span></h3>
      <p v-if="!spyData.futures.length" class="empty">보유 중인 선물 포지션이 없습니다</p>
      <table v-else class="tbl spy-tbl">
        <thead>
          <tr>
            <th>종목</th>
            <th>포지션</th>
            <th>진입가</th>
            <th>현재가</th>
            <th>💀 강제청산가</th>
            <th>증거금</th>
            <th>미실현 손익</th>
            <th>반대 저격</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="f in spyData.futures" :key="f.id">
            <td><b>{{ f.sym }}</b></td>
            <td><span class="side-badge" :class="f.side">{{ f.lev }}x {{ f.side === "long" ? "롱" : "숏" }}</span></td>
            <td class="num">{{ money(f.entry) }}</td>
            <td class="num">{{ money(m.quotes[f.sym]?.price ?? f.price) }}</td>
            <td class="num liq-price">{{ money(f.liq) }}</td>
            <td class="num">{{ money(f.margin) }}</td>
            <td class="num" :class="signClass(f.pnl)">{{ money(f.pnl) }} ({{ pct(f.pnlPct) }})</td>
            <td>
              <button
                type="button"
                class="snipe-btn"
                :class="f.side === 'long' ? 'short' : 'long'"
                @click="snipePosition(f.sym, 'fut', f.side === 'long' ? 'sell' : 'buy', f.lev)"
              >
                🎯 {{ f.side === "long" ? `${f.lev}x 숏 저격` : `${f.lev}x 롱 저격` }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <h3>📦 현물 보유 종목 ({{ spyData.positions.length }})</h3>
      <p v-if="!spyData.positions.length" class="empty">보유 중인 현물 종목이 없습니다</p>
      <table v-else class="tbl spy-tbl">
        <thead>
          <tr>
            <th>종목</th>
            <th>수량</th>
            <th>평단가</th>
            <th>현재가</th>
            <th>평가손익</th>
            <th>반대 저격</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in spyData.positions" :key="p.sym">
            <td><b>{{ p.sym }}</b></td>
            <td class="num">{{ qtyText(p.sym, p.qty) }}</td>
            <td class="num">{{ money(p.avg) }}</td>
            <td class="num">{{ money(m.quotes[p.sym]?.price ?? p.price) }}</td>
            <td class="num" :class="signClass(p.pnl)">{{ money(p.pnl) }} ({{ pct(p.pnlPct) }})</td>
            <td>
              <button
                type="button"
                class="snipe-btn short"
                @click="snipePosition(p.sym, 'fut', 'sell', 5)"
              >
                🎯 5x 숏 타격
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </dialog>

  <!-- 뉴비 가이드 모달 -->
  <dialog id="guideDlg" ref="guideDlg" aria-label="도파민 센터 뉴비 생존 가이드" @click="onGuideBackdrop">
    <div class="dlg-head">
      <h2>🔥 도파민 센터 뉴비 생존 &amp; 사냥 가이드</h2>
      <button type="button" class="dlg-close icon-btn" @click="closeGuide">닫기</button>
    </div>
    <div class="guide-grid">
      <div class="guide-card">
        <h3>1. 게임 목표: $100,000 → $10,000,000 (100배)</h3>
        <p>초기 시드 <b>$100,000</b>으로 시작해 시즌 종료 전까지 최고 수익률을 달성하세요. 100배($10M) 달성 시 <b>전광판 100배 졸업</b>에 등극하며, 파산 시 언제든 초기 시드로 즉시 재도전할 수 있습니다.</p>
      </div>
      <div class="guide-card">
        <h3>2. 현물 vs 선물 레버리지 (2x ~ 10x)</h3>
        <p><b>현물</b>은 강제청산이 없지만, <b>선물(롱·숏)</b>은 최대 10배 레버리지로 폭풍 수익을 노릴 수 있습니다. 단, 손실이 증거금의 <b>90%</b>에 도달하면 <b>강제청산</b>되어 전광판에 박제됩니다. 포지션 탭에서 <b>익절(TP)·손절(SL)</b>을 꼭 걸어두세요!</p>
      </div>
      <div class="guide-card">
        <h3>3. 실시간 속보 &amp; 3단계 신약/벤처 임상</h3>
        <p>상단 <b>LIVE 속보</b>와 종목 헤더의 <b>📰 종목 뉴스</b> 버튼을 주시하세요. 특히 벤처기업의 <b>1차→2차→최종 임상·승인</b> 3단계 이벤트는 대폭등 또는 상장폐지급 폭락을 부릅니다.</p>
      </div>
      <div class="guide-card">
        <h3>4. 🎯 포트폴리오 훔쳐보기 &amp; 청산 사냥</h3>
        <p>실시간 주문 체결은 <b>실제 시장 가격을 움직입니다!</b> 우측 <b>랭킹</b>이나 <b>채팅</b>에서 다른 유저 닉네임을 클릭해 <b>선물 진입가와 강제청산가</b>를 훔쳐보고, <b>[🎯 반대 저격]</b> 버튼으로 가격을 밀어 강제청산시킨 뒤 <b>[🤣 티배깅]</b>을 날려보세요!</p>
      </div>
      <div class="guide-card">
        <h3>5. 귓속말 작전 모의 &amp; 단축키</h3>
        <p>채팅창에서 유저 옆 <b>[귓속말]</b>을 누르거나 <code>/w 닉네임 내용</code>을 입력하면 둘만 보는 비밀 대화가 가능합니다. 단축키: <b>B</b>(매수/롱), <b>S</b>(매도/숏), <b>1~4</b>(비율 10~100%).</p>
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
