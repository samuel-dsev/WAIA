#!/bin/sh
set -eu

if [ "${1:-}" = "" ]; then
  printf '%s\n' "Uso: scripts/restore-postgres.sh ./backups/waia-backup-YYYYMMDDTHHMMSSZ" >&2
  exit 2
fi

BUNDLE=$1
POSTGRES_DB=${POSTGRES_DB:-waia}
POSTGRES_USER=${POSTGRES_USER:-waia_owner}
PROJECT=${WAIA_COMPOSE_PROJECT:-${COMPOSE_PROJECT_NAME:-}}

if [ -z "$PROJECT" ]; then
  printf '%s\n' "WAIA_COMPOSE_PROJECT e obrigatorio para impedir restore no ambiente errado." >&2
  exit 2
fi
if [ ! -d "$BUNDLE" ] || [ ! -f "$BUNDLE/postgres.dump" ] || [ ! -f "$BUNDLE/media.tar.gz" ] || [ ! -f "$BUNDLE/checksums.sha256" ]; then
  printf '%s\n' "Bundle de backup incompleto: $BUNDLE" >&2
  exit 2
fi
if [ "${RESTORE_ISOLATED:-}" != "true" ]; then
  printf '%s\n' "Esta rotina exige RESTORE_ISOLATED=true. Restore em producao requer procedimento e autorizacao separados." >&2
  exit 2
fi
EXPECTED_CONFIRM="RESTORE:$PROJECT:$POSTGRES_DB"
if [ "${RESTORE_CONFIRM:-}" != "$EXPECTED_CONFIRM" ]; then
  printf '%s\n' "Restauracao nao iniciada. Confirme o alvo com RESTORE_CONFIRM=$EXPECTED_CONFIRM." >&2
  exit 2
fi
command -v sha256sum >/dev/null 2>&1 || { printf '%s\n' "sha256sum e obrigatorio." >&2; exit 2; }
(cd "$BUNDLE" && sha256sum -c checksums.sha256)
docker compose -p "$PROJECT" exec -T postgres pg_restore --list < "$BUNDLE/postgres.dump" >/dev/null
tar -tzf "$BUNDLE/media.tar.gz" >/dev/null

services_stopped=false
report_incomplete_restore() {
  restore_status=$?
  if [ "$services_stopped" = true ]; then
    printf '%s\n' 'Restore interrompido. Reinicio automatico desabilitado; mantenha API e worker parados e confira banco, midia e migracoes antes de reiniciar manualmente.' >&2
  fi
  return "$restore_status"
}
trap report_incomplete_restore EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
services_stopped=true
docker compose -p "$PROJECT" stop api worker

docker compose -p "$PROJECT" exec -T postgres psql \
  --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --set=ON_ERROR_STOP=1 \
  --command="DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION CURRENT_USER"
docker compose -p "$PROJECT" exec -T postgres pg_restore \
  --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
  --no-owner --no-acl --section=pre-data < "$BUNDLE/postgres.dump"
# Backups anteriores à migration 020 possuem uma chamada recursiva sem schema.
# O ajuste temporário permite carregar esses dumps sob o search_path vazio do
# pg_restore; a migration executada abaixo substitui a função pela versão segura.
docker compose -p "$PROJECT" exec -T postgres psql \
  --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --set=ON_ERROR_STOP=1 \
  --command="ALTER FUNCTION public.flow_json_has_forbidden_key(jsonb) SET search_path = public, pg_catalog"
docker compose -p "$PROJECT" exec -T postgres pg_restore \
  --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
  --no-owner --no-acl --section=data < "$BUNDLE/postgres.dump"
docker compose -p "$PROJECT" exec -T postgres pg_restore \
  --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
  --no-owner --no-acl --section=post-data < "$BUNDLE/postgres.dump"
docker compose -p "$PROJECT" run --rm --no-deps -T --user 0:0 worker sh -c \
  'find /app/.data/media -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -C /app/.data/media -xzf -' \
  < "$BUNDLE/media.tar.gz"
docker compose -p "$PROJECT" run --rm --no-deps -T db-init
docker compose -p "$PROJECT" run --rm --no-deps -T migrate

docker compose -p "$PROJECT" start api worker
services_stopped=false
trap - EXIT HUP INT TERM
printf '%s\n' "Restore concluido em $PROJECT/$POSTGRES_DB. Valide health, RLS, filas e amostras de midia antes de usar o ambiente."
