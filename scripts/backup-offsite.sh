#!/bin/sh
set -eu

BACKUP_ROOT=${BACKUP_DIR:-/opt/waia/backups}
RCLONE_CONFIG_PATH=${RCLONE_CONFIG:-/etc/waia/rclone.conf}
OFFSITE_REMOTE=${WAIA_OFFSITE_REMOTE:-}

if [ -z "$OFFSITE_REMOTE" ]; then
  printf '%s\n' "WAIA_OFFSITE_REMOTE e obrigatorio e deve apontar para um remote crypt dedicado." >&2
  exit 2
fi
case "$OFFSITE_REMOTE" in
  *:*) ;;
  *) printf '%s\n' "WAIA_OFFSITE_REMOTE deve usar o formato remote:path." >&2; exit 2;;
esac
case "$BACKUP_ROOT" in ""|"/") printf '%s\n' "BACKUP_DIR inseguro." >&2; exit 2;; esac

command -v rclone >/dev/null 2>&1 || { printf '%s\n' "rclone e obrigatorio." >&2; exit 2; }
command -v sha256sum >/dev/null 2>&1 || { printf '%s\n' "sha256sum e obrigatorio." >&2; exit 2; }
[ -r "$RCLONE_CONFIG_PATH" ] || { printf '%s\n' "Configuracao rclone indisponivel." >&2; exit 2; }

REMOTE_NAME=${OFFSITE_REMOTE%%:*}
rclone config show "$REMOTE_NAME" --config "$RCLONE_CONFIG_PATH" | grep -Eq '^type = crypt$' || {
  printf '%s\n' "WAIA_OFFSITE_REMOTE deve referenciar um remote rclone do tipo crypt." >&2
  exit 2
}

LATEST_BUNDLE=$(find "$BACKUP_ROOT" -maxdepth 1 -mindepth 1 -type d -name 'waia-backup-*' -print | sort | tail -n 1)
[ -n "$LATEST_BUNDLE" ] || { printf '%s\n' "Nenhum bundle local completo foi encontrado." >&2; exit 2; }
[ -f "$LATEST_BUNDLE/checksums.sha256" ] || { printf '%s\n' "Bundle local sem checksums." >&2; exit 2; }

(cd "$LATEST_BUNDLE" && sha256sum -c checksums.sha256 >/dev/null)
BUNDLE_NAME=$(basename "$LATEST_BUNDLE")
REMOTE_ROOT=${OFFSITE_REMOTE%/}
REMOTE_BUNDLE="$REMOTE_ROOT/$BUNDLE_NAME"

rclone copy "$LATEST_BUNDLE" "$REMOTE_BUNDLE" \
  --config "$RCLONE_CONFIG_PATH" \
  --checkers 4 \
  --transfers 2 \
  --create-empty-src-dirs
rclone cryptcheck "$LATEST_BUNDLE" "$REMOTE_BUNDLE" \
  --config "$RCLONE_CONFIG_PATH" \
  --one-way

printf '%s\n' "$REMOTE_BUNDLE"
