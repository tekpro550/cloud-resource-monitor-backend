#!/usr/bin/env bash
# One-time (and safe to re-run) setup of the portal on an Ubuntu 22.04/24.04 VM.
#
#   sudo ./setup.sh
#
# 1. installs Docker Engine (if missing) and adds swap on small VMs
# 2. creates .env with generated secrets and asks for the required values
# 3. opens the firewall for SSH, HTTP and HTTPS
# 4. schedules the nightly database backup
# 5. pulls the images and starts the portal
set -euo pipefail
cd "$(dirname "$0")"
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo ./setup.sh" >&2; exit 1; }
here="$PWD"

envget() { sed -n "s/^$1=//p" .env | tail -n 1; }
envset() {
  KEY="$1" VAL="$2" awk 'BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VAL"] }
    index($0, k "=") == 1 { print k "=" v; done = 1; next } { print }
    END { if (!done) print k "=" v }' .env >.env.tmp
  cat .env.tmp >.env && rm -f .env.tmp
}
ask() { # ask KEY "Question" [hidden]
  [ -n "$(envget "$1")" ] && return 0
  local v=""
  while [ -z "$v" ]; do
    if [ "${3:-}" = hidden ]; then read -r -s -p "$2: " v; echo; else read -r -p "$2: " v; fi
  done
  envset "$1" "$v"
}

echo "== Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker info >/dev/null || { echo "Docker is not running." >&2; exit 1; }

mem_mb=$(awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo)
if [ "$mem_mb" -lt 3000 ] && ! swapon --show | grep -q .; then
  echo "== Adding a 2 GB swap file (VM has ${mem_mb} MB RAM)"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

echo "== Settings (.env)"
if [ ! -f .env ]; then
  cp .env.example .env
fi
chmod 600 .env
[ -n "$(envget POSTGRES_PASSWORD)" ] || envset POSTGRES_PASSWORD "$(openssl rand -hex 24)"
[ -n "$(envget SESSION_SECRET)" ] || envset SESSION_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
ask DOMAIN "Portal host name (e.g. portal.tekpro.com)"
ask ACME_EMAIL "Email for HTTPS certificate notices"
ask STORAGE_BUCKET "Lightsail bucket name"
ask STORAGE_REGION "Lightsail bucket region (e.g. ap-south-1)"
ask STORAGE_ACCESS_KEY_ID "Bucket access key ID"
ask STORAGE_SECRET_ACCESS_KEY "Bucket secret access key (hidden)" hidden
echo "Saved to $here/.env (edit it for email/SMTP and other options, then: sudo docker compose up -d)"

echo "== Firewall"
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
  ufw --force enable >/dev/null
  echo "ufw: SSH, 80 and 443 open"
fi

echo "== Nightly database backup (02:15 UTC)"
chmod +x backup.sh restore.sh
cat >/etc/cron.d/tekpro-portal-backup <<EOF
15 2 * * * root $here/backup.sh >>/var/log/tekpro-portal-backup.log 2>&1
EOF

echo "== Starting"
if ! docker compose pull; then
  echo
  echo "Could not pull the images. For a private Docker Hub repository run"
  echo "  sudo docker login -u tekprocloud"
  echo "and then run this script again."
  exit 1
fi
docker compose up -d

domain="$(envget DOMAIN)"
echo "Waiting for the portal to become ready..."
for _ in $(seq 1 60); do
  if docker compose exec -T portal /nodejs/bin/node -e \
    "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo
    echo "Portal is running: https://$domain"
    echo "(The HTTPS certificate is issued on first visit; this needs DNS for $domain pointing here.)"
    echo
    echo "Next: create the first Super Admin:"
    echo "  sudo docker compose run --rm portal bootstrap-superadmin"
    exit 0
  fi
  sleep 5
done
echo "The portal did not become ready. Check: sudo docker compose logs portal" >&2
exit 1
