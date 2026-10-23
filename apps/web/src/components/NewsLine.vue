<script setup lang="ts">
import type { NewsItem } from "@dopamine/engine";
import { computed, ref } from "vue";
import { badgeClass, badgeText, change, clock, dateText, pct } from "../format";
import { useAccount } from "../stores/account";
import { useMarket } from "../stores/market";

const m = useMarket();
const a = useAccount();
// 강제청산 알림 1건당 처음 누른 한 명만 성공한다. 문구는 서버가 만든다
async function react(liqId: number, type: "teabag" | "rip") {
  if (!a.me) { a.notify("참가해야 반응할 수 있습니다.", "error"); return; }
  await a.react(liqId, type);
}
const expanded = ref(false);
const latest = computed(() => m.news[0] ?? null);
const recent5 = computed(() => m.news.slice(0, 5));
const openDetail = (id: string) => { m.newsDialog = { mode: "detail", id }; };
const openLatest = () => { if (latest.value) openDetail(latest.value.id); };
const upcomingCount = computed(() => (m.research?.upcoming ?? []).filter(u => u.at > m.tick).length);

function symMove(n: NewsItem, sym: string): number | null {
  const p0 = n.priceAt[sym];
  const q = m.quotes[sym];
  if (!p0 || !q) return null;
  return change(q.price, p0);
}
</script>

<template>
  <div class="newsline-wrap">
    <!-- 전광판(청산·졸업·전설)은 LIVE 바 자리에 잠깐 뜬다. 줄이 새로 생기지 않아 아래 화면이 흔들리지 않는다 -->
    <div v-if="m.banner" id="megaphoneBanner" :key="`b${m.banner.id}`" class="newsline megaphone" :class="m.banner.kind" :style="m.banner.color ? { '--banner-color': m.banner.color } : undefined" title="눌러서 닫기" @click="m.banner = null">
      <span class="live">전광판</span>
      <span class="headline">{{ m.banner.text }}</span>
      <span v-if="m.banner.kind === 'liq'" class="banner-actions" @click.stop>
        <button type="button" class="teabag-btn" data-act="banner-teabag" @click="react(m.banner.id, 'teabag')">🤣 티배깅</button>
        <button type="button" class="teabag-btn rip" data-act="banner-rip" @click="react(m.banner.id, 'rip')">🕯️ 묵념</button>
      </span>
    </div>
    <div v-else :key="latest?.id ?? 'empty'" class="newsline" :class="{ 'is-event': !!latest?.event }" aria-live="polite" title="눌러서 자세히 보기" @click="openLatest">
      <span class="live">LIVE</span>
      <template v-if="latest">
        <span :class="badgeClass(latest)">{{ badgeText(latest) }}</span>
        <span v-if="latest.symbols.length" class="newsline-syms" @click.stop>
          <button v-for="s in latest.symbols.slice(0, 3)" :key="s" type="button" class="sym-tag news-sym-tag" @click="m.select(s)">
            ${{ s }}
            <small v-if="symMove(latest, s) != null" :class="symMove(latest, s)! >= 0 ? 'up' : 'down'">
              {{ pct(symMove(latest, s)!) }}
            </small>
          </button>
        </span>
        <span class="headline">{{ latest.headline }}</span>
        <time class="news-time">{{ dateText(latest.date) }} · {{ clock(latest.at) }}</time>
      </template>
      <span v-else class="headline muted">뉴스를 기다리는 중</span>
      <button
        id="floatNewsToggleBtn"
        type="button"
        class="icon-btn news-act-btn float-toggle-btn"
        :aria-pressed="m.floatingNewsOpen"
        title="웹페이지 안에서 이동·크기 조절 가능한 실시간 뉴스 창을 띄우거나 숨깁니다"
        @click.stop="m.toggleFloatingNews()"
      >
        🪟 실시간 뉴스창 {{ m.floatingNewsOpen ? "ON" : "OFF" }}
      </button>
      <button id="newsExpandBtn" type="button" class="icon-btn news-act-btn" :aria-expanded="expanded" @click.stop="expanded = !expanded">
        {{ expanded ? "접기 ▴" : "최근 5개 펼치기 ▾" }}
      </button>
      <button type="button" class="icon-btn news-act-btn" data-act="news-list" @click.stop="m.newsDialog = { mode: 'list' }">전체 뉴스</button>
      <button id="calendarBtn" type="button" class="icon-btn news-act-btn" title="예고된 지표 발표·실적·신제품 행사·ETF 심사" @click.stop="m.calendarOpen = true">
        📅 일정 <span v-if="upcomingCount" class="tab-cnt">{{ upcomingCount }}</span>
      </button>
    </div>
    <ul v-if="expanded" id="newsRecent5" class="news-recent5">
      <li v-for="(n, idx) in recent5" :key="n.id" class="recent5-item" :class="{ 'is-latest': idx === 0 }" @click="openDetail(n.id)">
        <span class="recent5-idx">{{ idx + 1 }}</span>
        <span :class="badgeClass(n)">{{ badgeText(n) }}</span>
        <div class="recent5-content">
          <div class="recent5-row">
            <b class="recent5-title">{{ n.headline }}</b>
            <span v-if="n.symbols.length" class="recent5-syms" @click.stop>
              <button v-for="s in n.symbols" :key="s" type="button" class="sym-tag news-sym-tag" @click="m.select(s)">
                ${{ s }}
                <small v-if="symMove(n, s) != null" :class="symMove(n, s)! >= 0 ? 'up' : 'down'">
                  {{ pct(symMove(n, s)!) }}
                </small>
              </button>
            </span>
          </div>
          <p class="recent5-body muted">{{ n.body }}</p>
        </div>
        <time class="recent5-time muted">{{ clock(n.at) }}</time>
      </li>
      <li v-if="!recent5.length" class="recent5-empty muted">아직 도착한 뉴스가 없습니다.</li>
    </ul>
  </div>
</template>
