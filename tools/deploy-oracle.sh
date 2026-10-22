#!/usr/bin/env bash
# Oracle Cloud (Ubuntu/ARM64·AMD64) 원클릭 배포 및 방화벽(80/443) 설정 스크립트
# 사용법: DOMAIN=dopamine.example.com ADMIN_KEY=나만의비밀키 bash tools/deploy-oracle.sh
set -euo pipefail

DOMAIN="${DOMAIN:-:80}"
ADMIN_KEY="${ADMIN_KEY:?ADMIN_KEY를 16자 이상으로 정하세요 (예: openssl rand -hex 16)}"

echo "[1/4] Docker 확인 및 설치..."
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER" || true
fi

echo "[2/4] Oracle Cloud 기본 iptables 80/443 포트 개방..."
if command -v iptables >/dev/null 2>&1; then
  sudo iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
  sudo iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
  if command -v netfilter-persistent >/dev/null 2>&1; then
    sudo netfilter-persistent save || true
  fi
fi

echo "[3/4] 환경 변수(.env) 기록 및 컨테이너 빌드·기동..."
cat > .env <<EOF
DOMAIN=${DOMAIN}
ADMIN_KEY=${ADMIN_KEY}
EOF

sudo DOMAIN="${DOMAIN}" ADMIN_KEY="${ADMIN_KEY}" docker compose up -d --build

echo "[4/4] 서버 헬스체크 대기..."
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4810/api/health >/dev/null 2>&1; then
    echo "배포 완료! 상태: $(curl -fsS http://127.0.0.1:4810/api/health)"
    exit 0
  fi
  sleep 1
done

echo "헬스체크 실패. 로그를 확인하세요: sudo docker compose logs"
exit 1
