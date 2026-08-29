#!/bin/sh
set -eu

BACKUP_DIR=${BACKUP_DIR:-./backups}
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-7}
POSTGRES_DB=${POSTGRES_DB:-waia}
POSTGRES_USER=${POSTGRES_USER:-waia}
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
FILE="$BACKUP_DIR/waia-postgres-$TIMESTAMP.dump"
TEMP_FILE="$FILE.partial.$$"

mkdir -p "$BACKUP_DIR"
trap 'rm -f "$TEMP_FILE"' EXIT HUP INT TERM
docker compose exec -T postgres pg_dump \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  --format=custom \
  --no-owner \
  --no-acl > "$TEMP_FILE"
docker compose exec -T postgres pg_restore --list < "$TEMP_FILE" >/dev/null
mv "$TEMP_FILE" "$FILE"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$FILE" > "$FILE.sha256"
fi
find "$BACKUP_DIR" -name "waia-postgres-*.dump" -mtime +"$RETENTION_DAYS" -delete
find "$BACKUP_DIR" -name "waia-postgres-*.dump.sha256" -mtime +"$RETENTION_DAYS" -delete
printf '%s\n' "$FILE"
