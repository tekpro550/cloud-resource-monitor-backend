#!/usr/bin/env bash
# Back up the portal database (pg_dump custom format) into ./backups, check the
# archive is readable, delete local backups older than BACKUP_RETENTION_DAYS and,
# if BACKUP_S3_BUCKET is set, copy the backup to that bucket.
#
#   sudo ./backup.sh
#
# setup.sh schedules this nightly. Document files are not included: they live in
# the bucket (see docs/BACKUP_RECOVERY.md for bucket versioning/replication).
set -euo pipefail
cd "$(dirname "$0")"
umask 077

# Reads KEY from .env without sourcing it (values may contain spaces and <>).
envget() { sed -n "s/^$1=//p" .env | tail -n 1; }

[ -f .env ] || { echo "No .env here; run setup.sh first." >&2; exit 1; }
retention="$(envget BACKUP_RETENTION_DAYS)"
retention="${retention:-14}"
mkdir -p backups
chmod 700 backups

name="tekpro_portal-$(date -u +%Y%m%dT%H%M%SZ).dump"
tmp="backups/.$name.partial"
trap 'rm -f "$tmp"' EXIT

docker compose exec -T postgres pg_dump -U portal -d tekpro_portal --format=custom >"$tmp"
docker compose exec -T postgres pg_restore --list >/dev/null <"$tmp"
mv "$tmp" "backups/$name"
echo "$(date -u +%FT%TZ) backup written: backups/$name ($(du -h "backups/$name" | cut -f1))"

find backups -maxdepth 1 -name 'tekpro_portal-*.dump' -mtime +"$retention" -print -delete

bucket="$(envget BACKUP_S3_BUCKET)"
if [ -n "$bucket" ]; then
  prefix="$(envget BACKUP_S3_PREFIX)"
  AWS_ACCESS_KEY_ID="$(envget BACKUP_S3_ACCESS_KEY_ID)" \
  AWS_SECRET_ACCESS_KEY="$(envget BACKUP_S3_SECRET_ACCESS_KEY)" \
  AWS_DEFAULT_REGION="$(envget BACKUP_S3_REGION)" \
    docker run --rm -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
      -v "$PWD/backups:/backups:ro" amazon/aws-cli:2.22.35 \
      s3 cp --only-show-errors "/backups/$name" "s3://$bucket/${prefix}$name"
  echo "$(date -u +%FT%TZ) copied to s3://$bucket/${prefix}$name"
fi
