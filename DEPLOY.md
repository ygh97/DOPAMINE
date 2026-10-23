# 배포·운영 가이드

도파민 센터 서버를 혼자 켜고, 업데이트하고, 지키는 방법이다. 명령은 모두 프로젝트 폴더(`dopamine-center`)에서 실행한다.

지금 운영 방식은 **A. 이 PC + Tailscale Funnel**이다. 서버가 이 PC에서 돌고, Tailscale Funnel이 고정 주소 `https://desktop-f349cdk.tail24dad6.ts.net`으로 밖에 연결해 준다. 재부팅해도 주소는 그대로다. 클라우드 서버(Oracle 등)로 옮기려면 **B. Docker**를 본다.

---

## 0. 처음 한 번만 준비

| 할 일 | 방법 |
|---|---|
| Node.js 24 이상 | `node -v`로 확인. 없으면 nodejs.org에서 LTS(24) 설치 |
| Git | `git -v`로 확인 |
| Tailscale | `winget install Tailscale.Tailscale` → `tailscale up`으로 로그인 → `tailscale funnel --bg 4810` (처음이면 나오는 링크에서 Funnel을 허용하고 다시 실행). 설정은 tailscaled 서비스가 기억해 재부팅 뒤에도 켜진다. 명령 위치는 `C:\Program Files\Tailscale\tailscale.exe` |
| 서버 켜기 | 프로젝트 폴더의 `start-server.cmd`를 더블클릭 (= `deploy.ps1 -SkipPull`). 자동으로 켜지지 않는다 |
| 코드 받기 | `git clone https://github.com/ygh97/DOPAMINE.git dopamine-center` (이미 있으면 생략) |
| 운영자 키 | 프로젝트 폴더에 `.env` 파일을 만들고 한 줄: `ADMIN_KEY=16자이상아무문자열`. git에 안 올라간다. 키가 없으면 운영자 기능(백업·새 시즌·채팅 관리)이 꺼진다 |

`.env`에 넣을 수 있는 값 (모두 선택, 서버가 켜질 때 읽는다):

| 이름 | 기본값 | 뜻 |
|---|---|---|
| `ADMIN_KEY` | 없음 | 운영자 키. 16자 이상 |
| `PORT` | 4810 | 서버 포트. 바꾸면 터널·스크립트의 `-Port`도 같이 바꾼다 |
| `SEASON_MS` | 28800000 (8시간) | 시즌 길이(밀리초). 진행 중 시즌에도 바로 적용 |
| `SEED` | 20261021 | 첫 시즌 seed. 이후 시즌은 무작위 |
| `BOTS` / `MARKET_MAKERS` | 0 / 꺼짐 | 실제 게임에 🤖 봇 N명, `MARKET_MAKERS=1`이면 🏦 세력·🐋 고래를 넣는다. 지금 운영은 `BOTS=100`, `MARKET_MAKERS=1` (사람이 들어오면 그 수만큼 봇이 쉰다). 끄려면 두 줄을 지우고 `deploy.ps1 -SkipPull` |
| `DB_FILE` | `data/dopamine.db` | 게임 DB 위치 |

---

## A. 이 PC + Tailscale Funnel (지금 방식)

### 한 번에: `tools\deploy.ps1`

```powershell
powershell -ExecutionPolicy Bypass -File tools\deploy.ps1            # 배포 (엔진을 바꿔도 시즌은 그대로 이어진다)
powershell -ExecutionPolicy Bypass -File tools\deploy.ps1 -NewSeason # 배포 + 지금 시즌을 끝내고 새 시즌 (원할 때만)
powershell -ExecutionPolicy Bypass -File tools\deploy.ps1 -Tunnel    # Funnel이 꺼져 있으면 켠다
powershell -ExecutionPolicy Bypass -File tools\deploy.ps1 -FreshStart  # 계정·명예의 전당만 남기고 전부 지운 뒤 새 시즌 (아래 "새로 시작")
powershell -ExecutionPolicy Bypass -File tools\deploy.ps1 -Stop      # 서버만 끄기 (끄기 전 스냅샷·백업)
```

옵션은 같이 쓸 수 있다. 재부팅 뒤에는 `start-server.cmd`(= `deploy.ps1 -SkipPull`)로 직접 켠다.

스크립트가 하는 일:
1. `git pull` (최신 코드. `-SkipPull`이면 건너뜀)
2. `npm install`
3. 켜져 있는 서버에 백업을 요청한 뒤 끈다 (포트 4810을 쓰는 프로세스)
4. `npm run build` (화면을 `apps/web/dist`로 빌드. 서버가 이 폴더를 같이 서빙한다)
5. 서버를 창 없이 켠다 (이 창을 닫아도 안 꺼진다). 로그는 `data\server.log`. 끌 때는 `-Stop`
6. `/api/health`가 응답할 때까지 기다린다 (재생 때문에 몇 초 걸릴 수 있다)
7. `-NewSeason`을 붙였을 때만 지금 시즌을 끝내고 새 시즌을 연다
8. Funnel 상태와 주소를 알려 준다 (`tailscale funnel status`). Funnel을 끄려면 `tailscale funnel --bg 4810 off`

### 배포해도 시즌은 이어진다
- 엔진(시세·호가창·뉴스)을 바꾼 배포도 시즌·계좌·차트가 그대로 이어지고, 바뀐 규칙은 그 순간부터 적용된다.
- 이유: 스크립트가 서버를 끄기 직전에 엔진 상태를 저장한다. 다시 켜면 거기서 이어서 꺼져 있던 몇 초만 재생한다.
- 엔진 상태 형식이 크게 바뀌어 저장본을 못 읽으면, 서버가 시즌 처음부터 기록된 주문 흐름으로 다시 만들어 이어 간다. 계좌는 그대로고, 지난 차트 모양만 조금 달라진다.
- 시즌을 새로 시작하고 싶을 때만 `-NewSeason`을 붙인다.

### 새로 시작 (계정·명예의 전당만 남기기): `-FreshStart`
- 남는 것: 계정(닉네임·비밀번호·로그인 상태·채팅 정지), 명예의 전당, 명예의 전당 기록이 있는 시즌 번호.
- 지우는 것: 진행 중·지난 시즌의 계좌·보유·선물·지정가·체결, 채팅, 차트 그림, 엔진 스냅샷, 봇·세력 계정.
- 새 시즌 번호는 명예의 전당에 기록이 있는 마지막 시즌 다음 번호다 (예: S1에만 전설이 있으면 S2로 시작).
- 지우기 전에 `data\backups\…-fresh-start.db`로 백업한다. 되돌리려면 아래 "백업과 복구".
- 서버 없이 DB만 정리하려면: 서버를 끄고 `node --disable-warning=ExperimentalWarning tools/fresh-start.ts`.
- 새 시즌을 열면: 백업 → 100배 전설만 명예의 전당 기록 → 모든 계좌 $100,000로 새로 시작. 접속 중인 화면은 알아서 새 시즌으로 바뀐다.

### 직접 하는 방법 (스크립트 없이)

```powershell
npm install
npm run build
npm start --workspace @dopamine/server          # 이 창이 서버. 닫으면 서버가 꺼진다
# Funnel은 한 번만 켜 두면 된다 (재부팅 뒤에도 유지)
tailscale funnel --bg 4810                      # 고정 주소 https://desktop-f349cdk.tail24dad6.ts.net
```

새 시즌을 직접 열 때 (PowerShell):

```powershell
$key = (Get-Content .env -Encoding UTF8 | Select-String '^ADMIN_KEY=').Line.Substring(10)
Invoke-RestMethod -Method Post http://127.0.0.1:4810/api/admin/new-season -Headers @{ 'x-admin-key' = $key } -ContentType 'application/json' -Body '{}'
```

### 알아 둘 것
- **주소는 고정이다.** 서버나 PC를 다시 켜도 `https://desktop-f349cdk.tail24dad6.ts.net` 그대로다. 주소는 Tailscale 관리 화면의 기기 이름(`desktop-f349cdk`)에서 나온다. 기기 이름을 바꾸면 주소도 바뀐다. 주소가 바뀌면 `apps/web/index.html`의 링크 미리보기(`og:url`, `og:image`)도 같이 고친다.
- 서버는 직접 켠다 (`start-server.cmd`). Funnel은 PC가 켜지면 같이 켜지지만, 서버를 켜기 전에는 502가 난다.
- 예전 Quick Tunnel도 쓸 수 있다: `cloudflared tunnel --url http://127.0.0.1:4810`. 주소는 켤 때마다 바뀐다.
- 서버가 꺼져 있던 동안은 시세도 멈춘다. 다시 켜면 마지막 tick에서 이어지고, 시즌 끝나는 시각도 꺼져 있던 시간만큼 늦춰진다. (절전은 서버를 안 끄므로 깨어날 때 그 시간만큼 시세를 채운다.)
- Funnel 주소에서는 SSE가 그대로 된다. `trycloudflare.com` 주소에서만 화면이 SSE 대신 1초 폴링(`/api/poll`)을 자동으로 쓴다.
- `npm run dev:server`(`--watch`)는 개발용이다. 실제 DB로 켜 둔 채 서버 파일을 고치면 바로 다시 떠서 시즌이 꼬일 수 있다. 운영은 `npm start`(스크립트)로 한다.

---

## B. Docker (클라우드 서버로 옮길 때)

`Dockerfile` + `docker-compose.yml` + `Caddyfile`이 준비돼 있다. Caddy가 자동 HTTPS를 붙인다.

```bash
# Ubuntu 서버 (Oracle Cloud 등). 80/443 포트를 열어 둔다
git clone https://github.com/ygh97/DOPAMINE.git dopamine-center && cd dopamine-center
DOMAIN=내도메인 ADMIN_KEY=16자이상키 bash tools/deploy-oracle.sh   # Docker 설치·방화벽·빌드·기동
# 업데이트
git pull && sudo docker compose up -d --build
# 새 시즌
curl -X POST -H "x-admin-key: 키" http://127.0.0.1:4810/api/admin/new-season
```

- 도메인이 없으면 `DOMAIN=서버IP.sslip.io`처럼 sslip.io를 쓴다.
- DB는 `./data`에 남는다 (컨테이너를 다시 만들어도 유지).
- 이 PC의 게임을 옮기려면 서버를 끈 뒤 `data/dopamine.db`를 새 서버의 `data/`에 복사한다.

---

## 백업과 복구

- 자동 백업: 서버를 켤 때, 시즌이 끝날 때, 하루 1회 → `data\backups\dopamine-날짜-…db`. 최근 20개만 남는다.
- 수동 백업: `Invoke-RestMethod -Method Post http://127.0.0.1:4810/api/admin/backup -Headers @{ 'x-admin-key' = $key } -ContentType 'application/json' -Body '{}'`
- 복구: 서버를 끄고(`deploy.ps1 -Stop`) `data\dopamine.db`, `dopamine.db-wal`, `dopamine.db-shm`을 다른 곳으로 옮긴 뒤, 원하는 백업 파일을 `data\dopamine.db`로 복사하고 다시 켠다 (`deploy.ps1 -SkipPull`).

---

## 운영자 API (헤더 `x-admin-key`)

| 요청 | 하는 일 |
|---|---|
| `POST /api/admin/new-season` | 지금 시즌 종료 → 새 시즌 |
| `POST /api/admin/backup` | 엔진 스냅샷 저장 + DB 백업 |
| `GET /api/admin/chat` | 최근 채팅·신고 수·차단 목록 |
| `POST /api/admin/ban` `{name, banned}` | 채팅 차단·해제 |
| `POST /api/admin/hide` `{id, hidden}` | 메시지 숨김·복원 |
| `GET /api/health` (키 없음) | 서버 상태: 시즌, tick, 접속 수, 부팅 시간 |

채팅 관리(차단·숨김)는 화면에서도 된다: 채팅 탭의 [관리] 버튼 → 운영자 키 입력.

---

## 문제가 생기면

| 증상 | 확인·해결 |
|---|---|
| 접속이 안 됨 | `curl http://127.0.0.1:4810/api/health`. 응답이 없으면 서버가 꺼진 것 → `deploy.ps1 -SkipPull`. 응답이 있으면 터널 문제 → `tailscale funnel status` 확인, 꺼져 있으면 `deploy.ps1 -SkipPull -Tunnel` |
| 서버가 안 켜짐 | `data\server.log` 끝부분 (`Get-Content data\server.log -Tail 30 -Encoding UTF8`). 포트를 다른 프로그램이 쓰면 `Get-NetTCPConnection -LocalPort 4810`으로 누가 쓰는지 본다 |
| 시세가 멈춤 | `/api/health`의 `tick`이 1초마다 오르는지 본다. 안 오르면 서버를 다시 켠다 |
| `npm install`·빌드 실패 | Node 버전(24 이상) 확인. 이 PC는 한글 사용자 경로라 Node의 `fs.rmSync`가 죽는 문제가 있다: `node_modules`를 지울 때는 탐색기나 `Remove-Item -Recurse -Force`를 쓴다 |
| 배포 뒤 가격이 이상함 | 스크립트 없이 엔진을 바꿔 배포했을 수 있다 → `deploy.ps1 -SkipPull -NewSeason` |

---

## 배포 전에 확인 (코드를 고쳤을 때)

```powershell
npm run check     # 테스트 + 타입체크 + 시뮬레이션 + 화면 종단 테스트 전부 (약 2분). 개발 서버를 켜 둔 채 돌려도 된다
npm run sim:bots  # 엔진·봇 수치를 바꿨으면: 졸업·전설 비율 확인 (약 30초)
git add -A; git commit -m "…"; git push
```

그다음 `deploy.ps1`로 배포한다 (같은 PC면 `-SkipPull`).
