# 도파민 센터

가상자산 실시간 모의투자 게임. 기획의 원본은 `SPEC.md`다. 규칙·수치를 바꾸면 SPEC.md부터 고친다.

## 구조

| 경로 | 내용 |
|---|---|
| `packages/engine` | 시세 엔진 (순수 TS). 카탈로그 `catalog.ts`, 뉴스 문구 `news-templates.ts`, 엔진 `market.ts` |
| `apps/server` | Fastify. `index.ts` 라우트·GameLoop·SSE, `broker.ts` 계좌·주문·정산·랭킹, `auth.ts` 참가·세션(scrypt), `season.ts` 시즌·엔진 재생, `db.ts` node:sqlite. 테스트 `test/broker.test.ts` |
| `apps/web` | Vue 3 + Vite + Pinia + KLineChart 9.8.12. 스토어 `stores/market.ts`, 차트 `components/PriceChart.vue`, 그리기 도구 `chart/drawing-tools.js` |
| `design/` | M0 시안과 엔진 프로토타입 (참고용, 더 이상 고치지 않음. 엔진의 원본은 `packages/engine`) |
| `tools/` | `sim-week.ts` 1주 시즌 보정 시뮬레이션, `e2e-m1.cjs`·`e2e-split.cjs` 실제 브라우저 종단 테스트 (공통 `e2e-lib.cjs`) |

## 명령

```bash
npm install
npm run dev:server        # http://127.0.0.1:4810  (8787은 다른 프로그램이 쓰고 있음)
npm run dev:web           # http://127.0.0.1:5173  (/api는 4810으로 프록시)
npm test                  # 엔진 11개 + 서버 21개 테스트 (node --test, 약 5초)
npm run typecheck         # engine·server는 tsc, web은 vue-tsc
npm run check             # 빠른 전체 확인: 테스트 + 타입체크 + 1일 시뮬레이션 + 빠른 E2E (약 16초)
npm run sim               # 1주 시즌 시뮬레이션, seed 3개 병렬 (약 16초). --days N으로 기간 조절
npm run e2e               # 서버+Vite를 띄우고 Playwright로 확인, 재연결 포함 (약 18초). e2e:quick은 약 5초
npm run e2e:split         # 주식병합 뒤 그린 선·액면가가 같은 배수로 옮겨지는지 (약 5초)
npm run e2e:m2            # 두 사람 참가·매수·매도·랭킹·새로고침·다시 시작 (약 8초)
npm run e2e:season        # 스냅샷 재시작, 15초 시즌 종료 → 명예의 전당 → 새 시즌 (약 16초)
npm run e2e:m4            # 선물 롱·숏·레버리지·스탑로스·분할 종료·강제 청산·리셋 제한 (약 6초)
npm run e2e:m5            # 차트 포지션 선·그리기 서버 동기화·모바일 반응형 (약 6초)
npm run e2e:m6            # 실시간 채팅·3초 쿨타임·금칙어·3인 신고 숨김·운영자 차단 (약 6초)
npm run e2e:m7            # 프로덕션 단일 포트 서빙·단축키·개인정보/투자고지 모달·SQLite 온라인 백업 (약 7초)
```

## 규칙

- Node 24 타입 스트리핑으로 서버·엔진을 빌드 없이 실행한다. **erasable 문법만** 쓴다 (enum, namespace, 생성자 파라미터 프로퍼티 금지). 상대 import는 `.ts` 확장자를 붙인다.
- TypeScript는 6.x에 고정. 7.x는 vue-tsc가 쓰는 JS API가 없어 web 타입체크가 깨진다.
- 엔진의 숨은 상태(대기 충격, 국면, 앵커, EPS)는 `Quote`·`Bar`·`NewsItem` 밖으로 내보내지 않는다. 엔진 테스트 "숨은 상태가 없다"가 이를 지킨다.
- 서버 환경 변수: `PORT` 4810, `TICK_MS` 1000, `SEASON_MS` 1주, `SEED`, `DB_FILE`, `ENGINE_OPTIONS`(테스트용 JSON).
- 엔진 상태를 바꾸는 필드를 추가하면 `snapshot()`/`restore()`에도 넣고 `SNAPSHOT_VERSION`을 올린다. 예약 작업은 함수가 아니라 `Task` 데이터로 둔다 (스냅샷에 담기게).
- DB는 기본 `data/dopamine.db` (git 제외). 테스트는 `DB_FILE`로 임시 파일을 쓴다. 시즌 중 엔진을 바꾸면 재생이 어긋나니 `data/`를 지우고 새 시즌으로 시작한다.
- 같은 seed면 같은 경로가 나와야 한다. 엔진에서 `Math.random()`·`Date.now()`를 직접 쓰지 않는다 (now는 입력으로 받는다).
- 뉴스 문구: 실존 인물 이름 금지, 실제 회사에 위법 혐의 금지, 원본("단타 아레나") 문구·증권사 이름 재사용 금지.
- UI 문구와 주석은 한국어. 상승 빨강 / 하락 파랑.
- 엔진 수치를 바꾸면 `npm test`와 `node tools/sim-week.ts`를 같이 돌려 1주 동안 대형주가 대략 0.5~2배 안에 머무는지, 신흥주가 10개로 유지되는지 확인한다.
- 화면을 바꾸면 `node tools/e2e-m1.cjs`로 실제 브라우저에서 확인한다.

## 현재 단계

M0~M7 전 마일스톤 및 추가 고도화 완료:
- 시세 엔진: 미국 시총 상위 20대 주식(실제 밸류에이션 기반 초기 PER) + 코인 5종(BTC·ETH·XRP·SOL·DOGE, PER 없음) + 신흥주 10종, 주간(게임 7일) 등락률 초기화, 숨은 세력 수급(개미털기·설거지·숏스퀴즈·스탑헌팅).
- 거래·포지션: 현물·선물 거래, 강제청산·스탑로스(SL)·익절(TP), 현물/선물/전량 일괄청산(`closeAll`), 내 거래 요약 통계 바, 체결 내역 현물/선물 유형 배지 및 원클릭 자랑 공유, 타인 포트폴리오 스캔(청산가·미실현손익 공개) 및 원클릭 반대 포지션 저격(`snipe`), 100배 졸업·강제청산 전광판 알림.
- 소셜·채팅·가이드: 말풍선 카드형 채팅 UI, 채팅 쿨타임 1초, `/w 닉네임` 비밀 귓속말, 강제청산 전광판 원클릭 티배깅/묵념 버튼, 종목별 뉴스 모아보기 필터(`📰 종목 뉴스`), 상단 `? 뉴비 가이드` 모달.
- 차트·UI: 초기 진입 시 최근 봉 위치 고정(이후 자유 스크롤), 대형 LIVE 뉴스 바 및 최근 5개 카드 펼치기, 상단 정중앙 닉네임·순위 배지, 좌측 종목 검색 및 정렬(기본·급등순·급락순·시총순), 단축키(B/S/1~4).
- 서버·인프라 최적화: SQLite `db.prepare` 전수 사전 컴파일, 틱당 1회 시세/봉 캐시, 랭킹 `O(1)` 맵 캐시, 정적 파일 메모리 캐시, Cloudflare 터널 폴링(`/api/poll`) 자동 호환, 온라인 백업, Docker + Caddy 배포 구성.
