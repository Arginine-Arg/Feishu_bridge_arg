#!/usr/bin/env bash
set -Eeuo pipefail

# Parallel, resumable copy of the VCC standardized parquet directories.
# The script never deletes files at the destination. Set DRY_RUN=1 (or pass
# --dry-run) to validate the remote listing and rsync arguments first.

REMOTE_HOST="${REMOTE_HOST:-wanghr_02@123.184.7.129}"
REMOTE_ROOT="${REMOTE_ROOT:-/ssd-g0004/PubData/vcc_standardized_data}"
LOCAL_ROOT="${LOCAL_ROOT:-/ssd1/arginine/parquet}"
JOBS="${JOBS:-6}"
LOG_FILE="${LOG_FILE:-$LOCAL_ROOT/transfer.log}"
DRY_RUN="${DRY_RUN:-0}"

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  shift
fi
if (($#)); then
  printf '用法: %s [--dry-run]\n' "$0" >&2
  exit 2
fi
if ! [[ "$JOBS" =~ ^[1-9][0-9]*$ ]]; then
  printf 'JOBS 必须是正整数，当前为: %s\n' "$JOBS" >&2
  exit 2
fi

for command in ssh rsync xargs; do
  command -v "$command" >/dev/null 2>&1 || {
    printf '缺少本地命令: %s\n' "$command" >&2
    exit 127
  }
done

mkdir -p -- "$LOCAL_ROOT"
touch -- "$LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2>&1

shell_quote() {
  local value=$1
  printf "'%s'" "${value//\'/\'\\\'\'}"
}

SSH_OPTIONS=(
  -o BatchMode=yes
  -o ConnectTimeout=15
  -o StrictHostKeyChecking=no
  -c aes128-gcm@openssh.com
)

REMOTE_ROOT_QUOTED=$(shell_quote "$REMOTE_ROOT")
REMOTE_FIND="find -- $REMOTE_ROOT_QUOTED -mindepth 1 -maxdepth 1 -type d -name '*parquet*' ! -name 'Tahoe100M_parquet' -print0"
MANIFEST=$(mktemp "${TMPDIR:-/tmp}/sync-parquet.XXXXXX")
trap 'rm -f -- "$MANIFEST"' EXIT

printf '开始 Parquet 传输\n'
printf '远端: %s:%s\n' "$REMOTE_HOST" "$REMOTE_ROOT"
printf '本地: %s\n' "$LOCAL_ROOT"
printf '并发: %s\n' "$JOBS"
printf '日志: %s\n' "$LOG_FILE"
printf '模式: %s\n' "$([[ "$DRY_RUN" == 1 ]] && printf dry-run || printf transfer)"

printf '检查 SSH 连通性...\n'
ssh "${SSH_OPTIONS[@]}" "$REMOTE_HOST" 'printf "ssh-ok\\n"'

printf '获取远端目录清单...\n'
ssh "${SSH_OPTIONS[@]}" "$REMOTE_HOST" "$REMOTE_FIND" >"$MANIFEST"

directory_count=$(tr -cd '\0' <"$MANIFEST" | wc -c | tr -d ' ')
printf '待处理目录: %s\n' "$directory_count"
if ((directory_count == 0)); then
  printf '没有找到匹配目录（已排除 Tahoe100M_parquet），无需传输。\n'
  exit 0
fi

RSYNC_SSH_COMMAND="ssh ${SSH_OPTIONS[*]}"

export REMOTE_HOST LOCAL_ROOT DRY_RUN RSYNC_SSH_COMMAND

copy_one() {
  local remote_path=$1
  local name=${remote_path##*/}
  [[ -n "$name" && "$name" != 'Tahoe100M_parquet' ]] || return 0
  printf '[%s] %s\n' "$(date '+%F %T')" "$name"
  local options=(-a -v --human-readable --info=progress2 --partial --inplace --protect-args -e "$RSYNC_SSH_COMMAND")
  [[ "$DRY_RUN" == 1 ]] && options+=(--dry-run)
  mkdir -p -- "$LOCAL_ROOT/$name"
  rsync "${options[@]}" "$REMOTE_HOST:$remote_path/" "$LOCAL_ROOT/$name/"
}
export -f copy_one

# NUL delimiting keeps directory names safe. xargs waits for all six workers
# and returns non-zero when any rsync worker fails.
xargs -0 -r -P "$JOBS" -I '{}' bash -c 'copy_one "$1"' _ '{}' <"$MANIFEST"

printf '传输完成。\n'
