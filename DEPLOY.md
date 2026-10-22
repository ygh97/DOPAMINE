# 배포·운영 가이드

도파민 센터 서버를 혼자 켜고, 업데이트하고, 지키는 방법이다. 명령은 모두 프로젝트 폴더(`dopamine-center`)에서 실행한다.

지금 운영 방식은 **A. 이 PC + Cloudflare Quick Tunnel**이다. 서버가 이 PC에서 돌고, `cloudflared`가 `https://….trycloudflare.com` 주소로 밖에 연결해 준다. 클라우드 서버(Oracle 등)로 옮기려면 **B. Docker**를 본다.

---

## 0. 처음 한 번만 준비

| 할 일 | 방법 |
|---|---|
| Node.js 24 이상 | `node -v`로 확인. 없으면 nodejs.org에서 LTS(24) 설치 |
| Git | `git -v`로 확인 |
| cloudflared | `cloudflared -v`로 확인. 없으면 `winget install Cloudflare.cloudflared` |
| 코드 받기 | `git clone https://github.com/ygh97/DOPAMINE.git dopamine-center` (이미 있으면 생략) |
| 운영자 키 | 프로젝트 폴더에 `.env` 파일을 만들고 한 줄: `ADMIN_KEY=16자이상아무문자열`. git에 안 올라간다. 키가 없으면 운영자 기능(백업·새 시즌·채팅 관리)이 꺼진다 |

`.env`에 넣을 수 있는 값 (모두 선택, 서버가 켜질 때 읽는다):

| 이름 | 기본값 | 뜻 |
|---|---|---|
| `ADMIN_KEY` | 없음 | 운영자 키. 16자 이상 |
| `PORT` | 4810 | 서버 포트. 바꾸면 터널·스크립트의 `-Port`도 같이 바꾼다 |
| `SEASON_MS` | 28800000 (8시간) | 시즌 길이(밀리초). 진행 중 시즌에도 바로 적용 |
| `SEED` | 20261021 | 첫 시즌 seed. 이후 시즌은 무작위 |
| `BOTS` / `MARKET_MAKERS` | 0 / 꺼짐 | 실제 게임에 🤖 봇 N명, `MARKET_MAKERS=1`이면 🏦 세력·🐋 고래를 넣는다 |
| `DB_FILE` | `data/dopamine.db` | 게임 DB 위치 |

---

## A. 이 PC + Cloudflare Quick Tunnel (지금 방식)

### 한 번에: `tools\deploy.ps1`

```powershell
powershell -ExecutionPolicy Bypass -File tools\deploy.ps1            # 업데이트 배포 (시즌 유지)
powershell -ExecutionPolicy Bypass -File tools\deploy.ps1 -NewSeason # 업데이트 + 새 시즌 (엔진·호가창 규칙이 바뀐 배포)
powershell -ExecutionPolicy Bypass -File tools\deploy.ps1 -Tunnel    # 터널이 꺼져 있으면 켜고 새 주소 출력
powershell -ExecutionPolicy Bypass -File tools\deploy.ps1 -Stop      # 서버만 끄기 (끄기 전 스냅샷·백업)
```

스크립트가 하는 일:
1. `git pull` (최신 코드. `-SkipPull`이면 건너뜀)
2. `npm install`
3. 켜져 있는 서버에 백업을 요청한 뒤 끈다 (포트 4810을 쓰는 프로세스)
4. `npm run build` (화면을 `apps/web/dist`로 빌드. 서버가 이 폴더를 같이 서빙한다)
5. 서버를 창 없이 켠다 (이 창을 닫아도 안 꺼진다). 로그는 `data\server.log`. 끌 때는 `-Stop`
6. `/api/health`가 응답할 때까지 기다린다 (재생 때문에 몇 초 걸릴 수 있다)
7. `-NewSeason`이면 지금 시즌을 끝내고 새 시즌을 연다
8. 터널 상태와 주소를 알려 준다. 터널은 서버만 다시 켜면 그대로라 주소도 안 바뀐다. `-Tunnel`로 켠 터널도 창 없이 돌고, 주소·로그는 `data\tunnel.log`. 터널만 끄려면 `Stop-Process -Name cloudflared`

### 새 시즌이 필요한 배포
- 엔진(`packages/engine`) 수치나 호가창 규칙을 바꾼 배포는 `-NewSeason`을 붙인다. 시즌 중간에 규칙이 바뀌면 재시작 재생이 어긋난다.
- 화면·채팅·문구만 바꾼 배포는 붙이지 않는다. 시즌이 그대로 이어진다.
- 새 시즌을 열면: 백업 → 100배 전설만 명예의 전당 기록 → 모든 계좌 $100,000로 새로 시작. 접속 중인 화면은 알아서 새 시즌으로 바뀐다.

### 직접 하는 방법 (스크립트 없이)

```powershell
npm install
npm run build
npm start --workspace @dopamine/server          # 이 창이 서버. 닫으면 서버가 꺼진다
# 다른 창에서
cloudflared tunnel --url http://127.0.0.1:4810  # 출력에 나오는 https://….trycloudflare.com 이 접속 주소
```

새 시즌을 직접 열 때 (PowerShell):

```powershell
$key = (Get-Content .env -Encoding UTF8 | Select-String '^ADMIN_KEY=').Line.Substring(10)
Invoke-RestMethod -Method Post http://127.0.0.1:4810/api/admin/new-season -Headers @{ 'x-admin-key' = $key } -ContentType 'application/json' -Body '{}'
```

### 알아 둘 것
- **Quick Tunnel 주소는 cloudflared를 다시 켤 때마다 바뀐다.** 서버만 다시 켜면 주소는 그대로다. PC를 재부팅했으면 `-Tunnel`로 켜고 새 주소를 공지한다. 고정 주소가 필요하면 Cloudflare 계정에서 Named Tunnel + 도메인을 쓴다.
- PC가 꺼지거나 절전에 들어가면 게임도 멈춘다. 다시 켜면 서버가 꺼져 있던 시간만큼 시세를 채운다 (tick은 벽시계 기준).
- `trycloudflare.com` 주소에서는 화면이 SSE 대신 1초 폴링(`/api/poll`)을 자동으로 쓴다.
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
| 접속이 안 됨 | `curl http://127.0.0.1:4810/api/health`. 응답이 없으면 서버가 꺼진 것 → `deploy.ps1 -SkipPull`. 응답이 있으면 터널 문제 → `cloudflared` 창 확인, 필요하면 끄고 `deploy.ps1 -SkipPull -Tunnel` |
| 서버가 안 켜짐 | `data\server.log` 끝부분 (`Get-Content data\server.log -Tail 30 -Encoding UTF8`). 포트를 다른 프로그램이 쓰면 `Get-NetTCPConnection -LocalPort 4810`으로 누가 쓰는지 본다 |
| 시세가 멈춤 | `/api/health`의 `tick`이 1초마다 오르는지 본다. 안 오르면 서버를 다시 켠다 |
| `npm install`·빌드 실패 | Node 버전(24 이상) 확인. 이 PC는 한글 사용자 경로라 Node의 `fs.rmSync`가 죽는 문제가 있다: `node_modules`를 지울 때는 탐색기나 `Remove-Item -Recurse -Force`를 쓴다 |
| 배포 뒤 가격이 이상함 | 엔진을 바꾸고 `-NewSeason` 없이 배포했을 수 있다 → `deploy.ps1 -SkipPull -NewSeason` |

---

## 배포 전에 확인 (코드를 고쳤을 때)

```powershell
npm run check     # 테스트 + 타입체크 + 시뮬레이션 + 화면 종단 테스트 전부 (약 2분). 개발 서버를 켜 둔 채 돌려도 된다
npm run sim:bots  # 엔진·봇 수치를 바꿨으면: 졸업·전설 비율 확인 (약 30초)
git add -A; git commit -m "…"; git push
```

그다음 `deploy.ps1`로 배포한다 (같은 PC면 `-SkipPull`).
