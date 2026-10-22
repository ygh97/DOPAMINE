# 도파민 센터

가상자산 실시간 모의투자 게임. 기획의 원본은 `SPEC.md`다. 규칙·수치를 바꾸면 SPEC.md부터 고친다. 배포·운영은 `DEPLOY.md`. 지난 설계·작업 기록은 `docs/` (고치지 않는다).

## 구조

| 경로 | 내용 |
|---|---|
| `packages/engine` | 순수 TS. 카탈로그 `catalog.ts`, 뉴스 문구·관련주·애널리스트 `news-templates.ts`, 시세 엔진 `market.ts`(화면에 안 나오는 기준가), 호가창 `exchange.ts`(호가 봇·즉시 체결·지정가·캔들). 테스트 `test/market.test.ts`, `test/exchange.test.ts` |
| `apps/server` | Fastify. `index.ts` 라우트·GameLoop·SSE, `broker.ts` 계좌·주문(호가창 체결)·지정가 묶음·청산·정산·랭킹, `bots.ts` 🤖 봇·🏦 세력·🐋 고래, `auth.ts` 참가·세션(scrypt), `season.ts` 시즌·엔진 재생, `chat.ts`, `db.ts` node:sqlite. 테스트 `test/broker.test.ts` |
| `apps/web` | Vue 3 + Vite + Pinia + KLineChart 9.8.12. 스토어 `stores/market.ts`·`account.ts`, 차트 `components/PriceChart.vue`, 호가창 `components/OrderBook.vue`, 주문 `OrderPanel.vue`, 보유·미체결 `HoldingsPanel.vue` |
| `tools/` | `sim-bots.ts` 졸업률 보정(봇 100 + 세력), `sim-week.ts` 엔진만 시즌 시뮬레이션, `e2e-*.cjs` 실제 브라우저 종단 테스트(공통 `e2e-lib.cjs`), `deploy.ps1` 이 PC 배포, `fresh-start.ts` 계정·명예의 전당만 남기고 새로 시작, `deploy-oracle.sh` Docker 배포, `dev-test.mjs` 테스트 서버, `load-test.ts` 부하 점검(`npm run loadtest`) |

## 명령

```bash
npm install
npm run dev:server        # http://127.0.0.1:4810  (8787은 다른 프로그램이 쓰고 있음)
npm run dev:web           # http://127.0.0.1:5173  (/api는 4810으로 프록시)
npm run dev:test          # 테스트 서버: 봇 100 + 세력 20 + 고래 10, http://127.0.0.1:5183 (서버 4820, data/test.db)
npm test                  # 엔진 23개 + 서버 32개 테스트 (node --test, 약 10초)
npm run typecheck         # engine·server는 tsc, web은 vue-tsc
npm run check             # 전체 확인: 테스트 + 타입체크 + 1일 시뮬레이션 + E2E 전부 (약 1분 40초). E2E는 4910·5273 포트라 dev 서버를 켜 둔 채 돌려도 된다
npm run sim:bots          # 봇 100 + 세력으로 시즌 1개를 seed 6개에 돌려 졸업률·거품·호가 봇 손익·tick 시간을 잰다 (약 30초)
npm run sim               # 엔진만 1주 시뮬레이션, seed 3개 병렬. --days 0.34 = 시즌 1개
npm run e2e               # 서버+Vite를 띄우고 Playwright로 확인, 재연결 포함 (약 18초). e2e:quick은 약 5초
npm run e2e:split         # 주식병합 뒤 그린 선·액면가가 같은 배수로 옮겨지는지
npm run e2e:m2            # 두 사람 참가·매수·매도·랭킹·새로고침·다시 시작
npm run e2e:season        # 스냅샷 재시작, 15초 시즌 종료 → 명예의 전당 → 새 시즌
npm run e2e:m4            # 선물 롱·숏·레버리지·스탑로스·분할 종료·강제 청산·리셋 제한
npm run e2e:m5            # 차트 포지션 선·그리기 서버 동기화·모바일 반응형
npm run e2e:m6            # 실시간 채팅·1초 쿨타임·금칙어·3인 신고 숨김·운영자 차단
npm run e2e:m7            # 프로덕션 단일 포트 서빙·단축키·개인정보/투자고지 모달·SQLite 온라인 백업
npm run e2e:m8            # 호가창 10단계·지정가 걸기·취소·전체 취소·내 지정가 체결(수수료 0)·호가 클릭·최근 체결·모바일 5단계
```

## 규칙

- Node 24 타입 스트리핑으로 서버·엔진을 빌드 없이 실행한다. **erasable 문법만** 쓴다 (enum, namespace, 생성자 파라미터 프로퍼티 금지). 상대 import는 `.ts` 확장자를 붙인다.
- TypeScript는 6.x에 고정. 7.x는 vue-tsc가 쓰는 JS API가 없어 web 타입체크가 깨진다.
- 엔진의 숨은 상태(대기 충격, 국면, 앵커, EPS, 기준가)와 호가 봇 재고는 `Quote`·`Bar`·`NewsItem`·`/api/book` 밖으로 내보내지 않는다. 엔진 테스트 "숨은 상태가 없다"가 이를 지킨다.
- 서버 환경 변수: `PORT` 4810, `TICK_MS` 1000, `SEASON_MS` 게임 1년(8시간), `SEED`, `DB_FILE`, `ADMIN_KEY`(16자 이상, 없으면 운영자 기능 꺼짐), `BOTS`·`MARKET_MAKERS`, `ENGINE_OPTIONS`·`EXCHANGE_OPTIONS`(테스트용 JSON). `dev`·`start`는 루트 `.env`(git 제외)를 자동으로 읽는다.
- 엔진·호가창 상태를 바꾸는 필드를 추가하면 `snapshot()`/`restore()`에도 넣는다. 예전 스냅샷에서 기본값으로 이어갈 수 있으면 `restore()`에서 채우고, 안 되면 `SNAPSHOT_VERSION`을 올린다. 예약 작업은 함수가 아니라 `Task` 데이터로 둔다 (스냅샷에 담기게).
- 주문 경로는 하나다: 사람·봇·세력 모두 `Broker` → `Exchange`. 체결 수량은 주식·신흥주 1주, 코인 0.000001 단위(`qtyUnit`). 호가 봇 물량도 같은 단위라 체결이 늘 단위의 배수다.
- GameLoop tick 순서: `broker.endTick()` → `exchange.step()` → `refundCancelled` → `settleTrades`(가격이 지나간 지정가를 호가 봇이 받은 체결) → `applyActions` → `runTriggers` → 봇. `tools/sim-bots.ts`와 서버 테스트의 `tick()`도 같은 순서로 맞춘다.
- DB는 기본 `data/dopamine.db` (git 제외). 테스트는 `DB_FILE`로 임시 파일을 쓴다. 배포는 시즌을 이어 간다: `tools/deploy.ps1`이 끄기 직전에 스냅샷을 저장해 재생이 몇 초뿐이다. 그래서 엔진의 `restore()`는 예전 스냅샷을 기본값으로 채워 읽어야 한다. 못 읽으면 `bootMarket`이 시즌 처음부터 다시 재생한다. 새 시즌은 `-NewSeason` 또는 `POST /api/admin/new-season`.
- 같은 seed면 같은 경로가 나와야 한다. 엔진·호가창에서 `Math.random()`·`Date.now()`를 직접 쓰지 않는다 (now는 입력으로 받는다). 봇은 계좌별 seed 난수만 쓴다.
- 뉴스 문구: 실존 인물 이름 금지, 실제 회사에 위법 혐의 금지, 원본("단타 아레나") 문구·증권사 이름 재사용 금지.
- UI 문구와 주석은 한국어. 상승 빨강 / 하락 파랑 (호가창도 매수 빨강 / 매도 파랑).
- 엔진·호가창·봇 수치를 바꾸면 `npm test`와 `npm run sim:bots`를 같이 돌린다. 목표: 20배 졸업 약 9~11%, 100배 전설 2~3%, 주식 시즌 중앙값 1.5~3배, tick 최대 100ms 안. 결과를 SPEC 5-2장에 적는다.
- dev 서버는 `--watch`라 서버·엔진 파일을 고치면 실제 `data/dopamine.db`로 바로 다시 뜬다. 시즌·정산 규칙을 바꿀 때는 dev 서버를 먼저 끈다. 운영 서버는 `npm start`(`tools/deploy.ps1`)로 켠다.
- 화면을 바꾸면 `node tools/e2e-m1.cjs`(호가창·주문이면 `e2e-m8.cjs`)로 실제 브라우저에서 확인한다.
- 이 PC 함정: Node 24.11.1의 `fs.rmSync`는 한글 사용자 경로에서 프로세스째 죽는다. 파일 삭제는 `unlinkSync`를 쓴다.

## 현재 단계

M0~M8 완료 (SPEC 9장). 운영: 이 PC에서 `npm start` + Cloudflare Quick Tunnel (DEPLOY.md A), `.env`에 `BOTS=100`·`MARKET_MAKERS=1`로 🤖 봇·🏦 세력·🐋 고래가 같이 돈다.

알려진 남은 문제:
- 🏦 세력은 세력1~세력20 이름으로 20~40분마다 전략을 바꾼다 (`bots.ts`의 `MM_STRATEGIES`, `MM_PERIOD`). sim-bots 통계에는 `세력N(지금 전략)`으로 나온다.
- 호가 봇 손익: 신흥주는 늘 이익, 코인은 대체로 손해(시즌당 수백만 달러). 공략 신호인지 지켜본다 (`sim:bots`의 "호가 봇 손익").
- 거품(적정가 대비 최대 괴리)이 주식 +40~70%로 설계 목표(±30%)보다 크다.
