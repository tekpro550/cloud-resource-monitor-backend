#!/usr/bin/env bash
# Replace the portal database with a backup made by backup.sh.
#
#   sudo ./restore.sh backups/tekpro_portal-20261030T021500Z.dump
#
# Takes a safety backup of the current database first, stops the portal while
# restoring, then starts it again. Everyone is signed out (sessions are restored
# from the backup, but any newer ones are lost).
set -euo pipefail
cd "$(dirname "$0")"

file="${1:-}"
[ -n "$file" ] && [ -f "$file" ] || { echo "Usage: sudo ./restore.sh <backup.dump>" >&2; exit 64; }
docker compose exec -T postgres pg_restore --list >/dev/null <"$file" || { echo "Not a readable backup: $file" >&2; exit 1; }

echo "This replaces ALL portal data (users, folders, permissions, documents list, audit log)"
echo "with the contents of $file."
read -r -p "Type RESTORE to continue: " answer
[ "$answer" = "RESTORE" ] || { echo "Cancelled."; exit 1; }

echo "Safety backup of the current database..."
./backup.sh

docker compose stop portal
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U portal -d postgres \
  -c "DROP DATABASE tekpro_portal WITH (FORCE)" \
  -c "CREATE DATABASE tekpro_portal OWNER portal"
docker compose exec -T postgres pg_restore -U portal -d tekpro_portal --no-owner --exit-on-error <"$file"
docker compose start portal
echo "Restored $file. The portal is starting (any newer migrations are applied automatically)."
