---
name: e2e-check
description: 도파민 센터 화면을 실제 브라우저로 종단 테스트한다. 서버와 Vite를 띄우고 Playwright로 시세 갱신, 차트, 뉴스 창, 그리기 도구, 다크 모드, 서버 재시작 후 재연결을 확인한다. 화면·스토어·서버 API를 고친 뒤 쓴다.
---

# 종단 테스트

```bash
npm run e2e:quick -- <스크린샷 폴더>   # 약 5초, 재연결 확인 생략
npm run e2e -- <스크린샷 폴더>         # 약 18초, 서버 재시작 후 재연결까지
npm run e2e:split -- <스크린샷 폴더>   # 약 5초, 주식병합 뒤 그린 선·액면가 확인
npm run e2e:m2 -- <스크린샷 폴더>      # 약 8초, 두 사람 참가·매수·매도·랭킹·새로고침·다시 시작
npm run e2e:season -- <스크린샷 폴더>  # 약 16초, 스냅샷 재시작 + 15초 시즌 종료 → 명예의 전당 → 새 시즌
npm run e2e:m4 -- <스크린샷 폴더>      # 약 6초, 선물 진입·스탑로스·분할 종료·강제 청산·리셋 제한
npm run e2e:m5 -- <스크린샷 폴더>      # 약 6초, 차트 포지션 선·그리기 서버 동기화·모바일 반응형
npm run e2e:m6 -- <스크린샷 폴더>      # 약 6초, 실시간 채팅·쿨타임·금칙어·신고 숨김·운영자 차단
npm run e2e:m7 -- <스크린샷 폴더>      # 약 7초, 프로덕션 빌드 단일 포트 서빙·단축키·고지 모달·SQLite 백업
npm run e2e:m8 -- <스크린샷 폴더>      # 약 15초, 호가창·지정가 걸기·취소·전체 취소·내 지정가 체결·호가 클릭·최근 체결·모바일 5단계
```

`e2e:split`은 서버를 `TICK_MS=40`, `ENGINE_OPTIONS={"splitPrice":1000,"warmupBars":120}`로 띄워 3초 안에 병합을 일으킨다. 엔진 설정을 바꿔 상황을 빨리 만드는 방식은 다른 시나리오에도 쓴다.

고정 대기 대신 값이 바뀔 때까지 폴링한다. 새 확인을 넣을 때도 `sleep` 대신 `changes()`나 `waitForFunction`을 쓴다.

- 서버는 매번 임시 DB(`DB_FILE`)로 뜬다. 실제 `data/dopamine.db`는 건드리지 않는다.
- 두 번째 사용자는 `browser.newContext()`로 새 세션을 만든다 (토큰이 localStorage라 같은 컨텍스트면 섞인다).
- 서버(4810)와 Vite(5173)를 직접 띄우고 끝나면 정리한다. 이미 떠 있으면 `--strictPort` 때문에 실패하니 먼저 끈다.
- Playwright는 REA에 들어 있는 `playwright-core`를 쓴다: `%APPDATA%/npm/node_modules/rea-agents/node_modules/playwright-core`. 다른 경로면 `PW` 환경 변수로 지정. 크롬 경로는 `CHROME`.
- 출력은 JSON. 통과 기준: `priceTicks.changed`, `rows` 10, `newsListCount` > 0, `theme` "dark", `drawingKept` ≥ 1, `reconnect.ticking`, `errors` 빈 배열, `failure` 없음. e2e:split은 `check.lineScaled`, `check.parMatches`가 true.
- 공통 코드(서버·Vite 띄우기, 브라우저 열기)는 `tools/e2e-lib.cjs`. 새 시나리오는 이걸 가져다 쓴다.
- 스크린샷 `m1-1-main.png`, `m1-2-dark-btc.png`를 열어 화면도 눈으로 본다.

## 알아둔 함정

- 주문·취소는 계정당 1초에 2건이다. 한 사람이 연달아 주문하는 시나리오는 사이에 1.1초를 기다린다 (e2e-m8 참고).
- 호가창을 얇게 해서 상황을 빨리 만들려면 `ENGINE_OPTIONS={"impactK":20}`(두께 ∝ 1/K²)이나 `EXCHANGE_OPTIONS`(안전 물량 거리 등)를 쓴다.

- Windows에서 `spawn(..., { shell: true })`로 띄우면 kill이 자식 node까지 안 닿는다. `process.execPath`로 node를 직접 띄운다.
- Vite 프록시는 백엔드가 죽어도 SSE 연결을 닫아 주지 않을 때가 있다. 그래서 스토어에 5초 무응답 감시(watchdog)가 있다.
- KLineChart는 합성 마우스 이벤트(dispatchEvent)로는 그리기가 안 된다. Playwright `page.mouse`처럼 실제 입력을 쓴다.
- KLineChart는 0.5초 안의 연속 클릭을 더블클릭으로 처리한다. 여러 점을 찍는 도구는 클릭 사이에 650ms 이상 기다린다.
- KLineChart 내부에 z-index 20 요소가 있다. 그 위에 떠야 하는 메뉴는 z-index를 더 크게 준다.
- 서버를 일부러 내린 동안의 프록시 500 오류는 테스트가 무시한다 (`restarting` 플래그).
