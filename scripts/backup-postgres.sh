#!/bin/sh
set -eu

BACKUP_ROOT=${BACKUP_DIR:-./backups}
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-7}
POSTGRES_DB=${POSTGRES_DB:-waia}
POSTGRES_USER=${POSTGRES_USER:-waia_owner}
PROJECT=${WAIA_COMPOSE_PROJECT:-${COMPOSE_PROJECT_NAME:-}}
KEYRING_REFERENCE=${KEYRING_CUSTODY_REFERENCE:-}

if [ -z "$PROJECT" ]; then
  printf '%s\n' "WAIA_COMPOSE_PROJECT e obrigatorio para impedir backup do ambiente errado." >&2
  exit 2
fi
if [ -z "$KEYRING_REFERENCE" ]; then
  printf '%s\n' "KEYRING_CUSTODY_REFERENCE e obrigatorio e deve identificar a copia externa do keyring, nunca conter a chave." >&2
  exit 2
fi
case "$BACKUP_ROOT" in ""|"/") printf '%s\n' "BACKUP_DIR inseguro." >&2; exit 2;; esac
case "$RETENTION_DAYS" in *[!0-9]*|"") printf '%s\n' "BACKUP_RETENTION_DAYS invalido." >&2; exit 2;; esac
command -v sha256sum >/dev/null 2>&1 || { printf '%s\n' "sha256sum e obrigatorio." >&2; exit 2; }

TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
BUNDLE="$BACKUP_ROOT/waia-backup-$TIMESTAMP"
TEMP_BUNDLE="$BUNDLE.partial.$$"
mkdir -p "$BACKUP_ROOT" "$TEMP_BUNDLE"
trap 'rm -rf "$TEMP_BUNDLE"' EXIT HUP INT TERM

docker compose -p "$PROJECT" exec -T postgres pg_dump \
  --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
  --format=custom --no-owner --no-acl > "$TEMP_BUNDLE/postgres.dump"
docker compose -p "$PROJECT" exec -T postgres pg_restore --list < "$TEMP_BUNDLE/postgres.dump" >/dev/null

docker compose -p "$PROJECT" exec -T worker tar -C /app/.data/media -czf - . > "$TEMP_BUNDLE/media.tar.gz"
tar -tzf "$TEMP_BUNDLE/media.tar.gz" >/dev/null

{
  printf 'format=waia-backup-v1\n'
  printf 'created_at=%s\n' "$TIMESTAMP"
  printf 'source_project=%s\n' "$PROJECT"
  printf 'postgres_db=%s\n' "$POSTGRES_DB"
  printf 'postgres_user=%s\n' "$POSTGRES_USER"
  printf 'keyring_custody_reference=%s\n' "$KEYRING_REFERENCE"
} > "$TEMP_BUNDLE/manifest.txt"
(cd "$TEMP_BUNDLE" && sha256sum postgres.dump media.tar.gz manifest.txt > checksums.sha256)
(cd "$TEMP_BUNDLE" && sha256sum -c checksums.sha256 >/dev/null)

mv "$TEMP_BUNDLE" "$BUNDLE"
trap - EXIT HUP INT TERM
find "$BACKUP_ROOT" -maxdepth 1 -type d -name 'waia-backup-*' -mtime +"$RETENTION_DAYS" -exec rm -rf -- {} \;
printf '%s\n' "$BUNDLE"
