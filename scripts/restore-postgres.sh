#!/bin/sh
set -eu

if [ "${1:-}" = "" ]; then
  printf '%s\n' "Uso: scripts/restore-postgres.sh ./backups/arquivo.dump" >&2
  exit 2
fi

BACKUP_FILE=$1
POSTGRES_DB=${POSTGRES_DB:-waia}
POSTGRES_USER=${POSTGRES_USER:-waia}

if [ ! -f "$BACKUP_FILE" ]; then
  printf '%s\n' "Backup nao encontrado: $BACKUP_FILE" >&2
  exit 2
fi

if [ "${RESTORE_CONFIRM:-}" != "RESTORE_WAIA" ]; then
  printf '%s\n' "Restauracao nao iniciada. Execute com RESTORE_CONFIRM=RESTORE_WAIA apos validar o alvo." >&2
  exit 2
fi

if [ -f "$BACKUP_FILE.sha256" ] && command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c "$BACKUP_FILE.sha256"
fi
docker compose exec -T postgres pg_restore --list < "$BACKUP_FILE" >/dev/null

docker compose stop api worker
docker compose exec -T postgres pg_restore \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  --clean \
  --if-exists \
  --no-owner \
  --no-acl < "$BACKUP_FILE"
docker compose start api worker
