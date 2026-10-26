# 도파민 센터: 이 PC에서 서버 업데이트·재시작 (Tailscale Funnel 고정 주소 운영용). 사용법은 DEPLOY.md.
#
#   powershell -ExecutionPolicy Bypass -File tools\deploy.ps1         # 최신 코드 받기 → 설치 → 화면 빌드 → 서버 재시작 (시즌은 그대로 이어진다)
#   powershell -ExecutionPolicy Bypass -File tools\deploy.ps1 -Stop   # 서버만 끈다
#   -SkipPull: git pull 안 함 / -Tunnel: Funnel이 꺼져 있으면 켠다 / -NewSeason: 지금 시즌을 끝내고 새 시즌
#   -FreshStart: 계정·명예의 전당만 남기고 전부 지운 뒤 새 시즌 (tools/fresh-start.ts, 지우기 전 백업)
#   -FreshStart -WipeHall: 명예의 전당도 지우고 S1부터 (계정만 남김)
param([switch]$NewSeason, [switch]$FreshStart, [switch]$WipeHall, [switch]$Stop, [switch]$SkipPull, [switch]$Tunnel, [int]$Port = 4810)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Api = "http://127.0.0.1:$Port"
New-Item -ItemType Directory -Force (Join-Path $Root "data") | Out-Null

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function AdminKey {
  # -Encoding UTF8: PowerShell 5.1 기본(ANSI)으로 읽으면 한글 주석 끝의 줄바꿈이 깨져 다음 줄과 붙는다
  $line = Get-Content (Join-Path $Root ".env") -Encoding UTF8 -ErrorAction SilentlyContinue | Where-Object { $_ -match "^ADMIN_KEY=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return $line.Substring(10).Trim()
}
# 창 없이, 이 PowerShell 창과 완전히 분리해서 띄운다 (WMI). 이 창을 닫거나 Ctrl+C를 눌러도 서버가 안 꺼진다
function Detached($commandLine) {
  $si = New-CimInstance -ClassName Win32_ProcessStartup -Property @{ ShowWindow = [uint16]0 } -ClientOnly
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine; CurrentDirectory = $Root; ProcessStartupInformation = $si }
  if ($r.ReturnValue -ne 0) { throw "프로세스를 띄우지 못했습니다 (코드 $($r.ReturnValue)): $commandLine" }
}
function ServerPid {
  $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.OwningProcess }
  return $null
}
function StopServer {
  $id = ServerPid
  if (-not $id) { Write-Host "켜져 있는 서버 없음 (포트 $Port)"; return }
  $key = AdminKey
  if ($key) {
    # 끄기 전에 엔진 스냅샷 + DB 백업. 다시 켤 때 재생이 꺼져 있던 몇 초뿐이라, 엔진 코드가 바뀌어도 시즌이 자연스럽게 이어진다
    try { Invoke-RestMethod -Method Post -Uri "$Api/api/admin/backup" -Headers @{ "x-admin-key" = $key } -ContentType "application/json" -Body "{}" -TimeoutSec 30 | Out-Null; Write-Host "스냅샷·백업 저장" }
    catch { Write-Host "백업 요청 실패 (계속 진행): $($_.Exception.Message)" -ForegroundColor Yellow }
  }
  Stop-Process -Id $id -Force
  for ($i = 0; $i -lt 20 -and (ServerPid); $i++) { Start-Sleep -Milliseconds 500 }
  Write-Host "서버 종료 (PID $id)"
}

if ($Stop) { Step "서버 끄기"; StopServer; exit 0 }

if (-not $SkipPull) {
  Step "최신 코드 받기 (git pull)"
  git pull --ff-only
  if ($LASTEXITCODE -ne 0) { throw "git pull 실패. 내 PC에서 고친 파일이 있으면 먼저 커밋하거나 되돌리세요." }
}

Step "패키지 설치 (npm install)"
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install 실패" }

Step "서버 끄기"
StopServer

if ($FreshStart) {
  if ($WipeHall) {
    Step "새로 시작 (계정만 남기고 S1부터)"
    node --disable-warning=ExperimentalWarning tools/fresh-start.ts --hall
  } else {
    Step "새로 시작 (계정·명예의 전당만 남김)"
    node --disable-warning=ExperimentalWarning tools/fresh-start.ts
  }
  if ($LASTEXITCODE -ne 0) { throw "새로 시작 실패. 서버는 꺼진 상태입니다. data\backups의 fresh-start 백업으로 되돌릴 수 있습니다." }
}

Step "화면 빌드 (npm run build)"
npm run build
if ($LASTEXITCODE -ne 0) { throw "화면 빌드 실패. 서버는 꺼진 상태입니다. 고친 뒤 다시 실행하세요." }

Step "서버 켜기 (로그: data\server.log)"
$log = Join-Path $Root "data\server.log"
Detached "cmd.exe /c npm start --workspace @dopamine/server >> `"$log`" 2>&1"
$health = $null
for ($i = 0; $i -lt 120 -and -not $health; $i++) {
  Start-Sleep -Seconds 1
  try { $health = Invoke-RestMethod -Uri "$Api/api/health" -TimeoutSec 2 } catch { }
}
if (-not $health) { throw "서버가 2분 안에 뜨지 않았습니다. data\server.log 끝부분을 보세요." }
Write-Host "서버 켜짐: 시즌 $($health.season), tick $($health.tick), 재생 $($health.replayed) tick, 부팅 $($health.bootMs)ms"

if ($FreshStart) { $NewSeason = $false } # 이미 새 시즌으로 열렸다
if ($NewSeason) {
  Step "새 시즌 시작"
  $key = AdminKey
  if (-not $key -or $key.Length -lt 16) { throw ".env에 ADMIN_KEY(16자 이상)가 없어 새 시즌을 시작할 수 없습니다." }
  $r = Invoke-RestMethod -Method Post -Uri "$Api/api/admin/new-season" -Headers @{ "x-admin-key" = $key } -ContentType "application/json" -Body "{}" -TimeoutSec 60
  Write-Host "시즌 $($r.ended) 종료 → 시즌 $($r.season) 시작"
}

Step "고정 주소 (Tailscale Funnel)"
# Funnel 설정은 tailscaled가 기억해서 재부팅해도 같은 주소로 다시 켜진다. 처음 한 번만 로그인·Funnel 허용이 필요하다 (DEPLOY.md A)
$ts = "C:\Program Files\Tailscale\tailscale.exe"
if (-not (Test-Path $ts)) { throw "Tailscale이 없습니다: winget install Tailscale.Tailscale" }
$funnel = (& $ts funnel status 2>&1 | Out-String)
if ($Tunnel -and $funnel -notmatch "Funnel on") { & $ts funnel --bg $Port | Out-Null; $funnel = (& $ts funnel status 2>&1 | Out-String) }
# Funnel 목록에 예전 기기 이름 주소가 남아 있을 수 있어, 이 기기의 실제 이름(tailscale status의 DNSName)과 같은 주소만 보여 준다
$dns = $null
try { $dns = ((& $ts status --json | Out-String | ConvertFrom-Json).Self.DNSName).TrimEnd(".") } catch {}
$m = if ($dns) { [regex]::Match($funnel, "https://" + [regex]::Escape($dns)) } else { [regex]::Match($funnel, "https://[a-z0-9.-]+\.ts\.net") }
if ($funnel -match "Funnel on" -and $m.Success) { Write-Host "주소: $($m.Value)" -ForegroundColor Green }
else { Write-Host "Funnel이 꺼져 있습니다. -Tunnel을 붙여 다시 실행하거나 직접: tailscale funnel --bg $Port" -ForegroundColor Yellow }
Write-Host "`n완료" -ForegroundColor Green
