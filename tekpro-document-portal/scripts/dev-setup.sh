#!/usr/bin/env bash
# One-time local development setup (macOS/Linux):
#   checks Node and Docker, starts PostgreSQL + a local S3 server, writes .env
#   (only if missing), creates the bucket, installs dependencies and applies migrations.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

say "Checking Node.js"
command -v node >/dev/null || fail "Node.js is not installed. Install Node.js 22 LTS from https://nodejs.org"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)?0:1)' \
  || fail "Node.js $(node -v) is too old. Install Node.js 22.12 or newer."
echo "Node $(node -v), npm $(npm -v)"

say "Checking Docker"
command -v docker >/dev/null || fail "Docker is not installed. Install Docker Desktop from https://www.docker.com"
docker info >/dev/null 2>&1 || fail "Docker is not running. Open Docker Desktop, wait until it says it is running, then retry."

say "Starting PostgreSQL and the local S3 server"
docker compose -f docker-compose.dev.yml up -d --wait

if [ ! -f .env ]; then
  say "Creating .env for local development"
  SECRET=$(node -e 'console.log(require("crypto").randomBytes(48).toString("base64"))')
  CONN_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')
  PG_PORT=${PORTAL_PG_PORT:-5432}
  S3_PORT=${PORTAL_S3_PORT:-5050}
  sed \
    -e "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://portal:portal@localhost:${PG_PORT}/tekpro_portal?schema=public|" \
    -e "s|^SESSION_SECRET=.*|SESSION_SECRET=${SECRET}|" \
    -e "s|^APP_BASE_URL=.*|APP_BASE_URL=http://localhost:5173|" \
    -e "s|^STORAGE_ENDPOINT=.*|STORAGE_ENDPOINT=http://localhost:${S3_PORT}|" \
    -e "s|^STORAGE_REGION=.*|STORAGE_REGION=us-east-1|" \
    -e "s|^STORAGE_BUCKET=.*|STORAGE_BUCKET=tekpro-dev|" \
    -e "s|^STORAGE_ACCESS_KEY_ID=.*|STORAGE_ACCESS_KEY_ID=test|" \
    -e "s|^STORAGE_SECRET_ACCESS_KEY=.*|STORAGE_SECRET_ACCESS_KEY=test|" \
    -e "s|^STORAGE_FORCE_PATH_STYLE=.*|STORAGE_FORCE_PATH_STYLE=true|" \
    -e "s|^MAIL_DRIVER=.*|MAIL_DRIVER=console|" \
    -e "s|^ALLOW_ADMIN_RESET_LINKS=.*|ALLOW_ADMIN_RESET_LINKS=true|" \
    -e "s|^# CONNECTOR_ENCRYPTION_KEY=.*|CONNECTOR_ENCRYPTION_KEY=${CONN_KEY}|" \
    -e "s|^# CONNECTOR_AWS_ACCESS_KEY_ID=.*|CONNECTOR_AWS_ACCESS_KEY_ID=test|" \
    -e "s|^# CONNECTOR_AWS_SECRET_ACCESS_KEY=.*|CONNECTOR_AWS_SECRET_ACCESS_KEY=test|" \
    -e "s|^# CONNECTOR_STS_REGION=.*|CONNECTOR_STS_REGION=us-east-1|" \
    -e "s|^# CONNECTOR_STS_ENDPOINT=.*|CONNECTOR_STS_ENDPOINT=http://localhost:${S3_PORT}|" \
    -e "s|^# CONNECTOR_ALLOW_INSECURE_ENDPOINTS=.*|CONNECTOR_ALLOW_INSECURE_ENDPOINTS=true|" \
    .env.example > .env
else
  say ".env already exists - leaving it unchanged"
fi

# Older .env files predate customer storage connections: add the key that encrypts
# customer access keys (needed to save an "access key" connection) if it is missing.
if ! grep -Eq '^CONNECTOR_ENCRYPTION_KEY=.+' .env; then
  say "Adding CONNECTOR_ENCRYPTION_KEY to .env"
  printf '\n# Encrypts customer storage access keys at rest (keep it: changing it makes saved keys unreadable)\nCONNECTOR_ENCRYPTION_KEY=%s\n' \
    "$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')" >> .env
fi

say "Installing dependencies"
npm ci
npm run prisma:generate -w backend

say "Creating the storage buckets"
node --env-file=.env scripts/dev-create-bucket.mjs

say "Applying database migrations"
npm run db:migrate

cat <<'MSG'

Setup complete.

Next:
  1. Create your administrator account (once):
       npm run bootstrap:superadmin -- --email you@example.com --name "Your Name"
  2. Start the portal:
       npm run dev
  3. Open http://localhost:5173 and sign in.

Stop the local services later with:
  docker compose -f docker-compose.dev.yml down
MSG
