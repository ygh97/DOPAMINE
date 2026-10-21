<script setup lang="ts">
import type { NewsItem } from "@dopamine/engine";
import { computed, ref } from "vue";
import { badgeClass, badgeText, change, clock, dateText, pct } from "../format";
import { useMarket } from "../stores/market";

const m = useMarket();
const expanded = ref(false);
const latest = computed(() => m.news[0] ?? null);
const recent5 = computed(() => m.news.slice(0, 5));
const openDetail = (id: string) => { m.newsDialog = { mode: "detail", id }; };
const openLatest = () => { if (latest.value) openDetail(latest.value.id); };

function symMove(n: NewsItem, sym: string): number | null {
  const p0 = n.priceAt[sym];
  const q = m.quotes[sym];
  if (!p0 || !q) return null;
  return change(q.price, p0);
}
</script>

<template>
  <div class="newsline-wrap">
    <div :key="latest?.id ?? 'empty'" class="newsline" :class="{ 'is-event': !!latest?.event }" aria-live="polite" title="눌러서 자세히 보기" @click="openLatest">
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
      <button type="button" class="icon-btn news-act-btn" @click.stop="m.newsDialog = { mode: 'list' }">전체 뉴스</button>
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
