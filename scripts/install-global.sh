#!/bin/sh

set -eu

REPOSITORY="Arginine-Arg/Feishu_bridge_arg"
ARCHIVE=""
CHECKSUM=""
VERSION=""
PREFIX=""
TEMP_DIR=""

usage() {
  cat <<'EOF'
Install arg-bridge from a verified GitHub Release tarball.

Usage:
  install-global.sh [--version VERSION] [--prefix PATH]
  install-global.sh --archive PATH [--checksum PATH] [--prefix PATH]

Options:
  --version VERSION  Install a specific release, for example 0.5.6.
  --archive PATH     Install a local tarball instead of downloading one.
  --checksum PATH    Verify a local tarball against this SHA256 file.
  --prefix PATH      Use a custom npm global prefix.
  -h, --help         Show this help.
EOF
}

die() {
  printf 'arg-bridge installer: %s\n' "$*" >&2
  exit 1
}

require_value() {
  option="$1"
  value="${2-}"
  [ -n "$value" ] || die "$option requires a value"
}

download() {
  url="$1"
  destination="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --retry-delay 2 --connect-timeout 15 \
      --output "$destination" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget --tries=3 --timeout=15 --output-document="$destination" "$url"
  else
    die "curl or wget is required to download the release"
  fi
}

sha256_file() {
  file="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{print $NF}'
  else
    die "sha256sum, shasum, or openssl is required to verify the release"
  fi
}

verify_archive() {
  archive="$1"
  checksum_file="$2"
  expected="$(awk 'NR == 1 {print $1}' "$checksum_file" | tr 'A-F' 'a-f')"

  printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$' || \
    die "invalid SHA256 file: $checksum_file"

  actual="$(sha256_file "$archive" | tr 'A-F' 'a-f')"
  [ "$actual" = "$expected" ] || die "SHA256 verification failed for $archive"
  printf 'Verified SHA256: %s\n' "$actual"
}

clean_broken_link() {
  path="$1"
  if [ -L "$path" ] && [ ! -e "$path" ]; then
    printf 'Removing stale npm link: %s\n' "$path"
    rm -f "$path"
  fi
}

is_legacy_launcher() {
  path="$1"
  [ -f "$path" ] || return 1
  LC_ALL=C grep -Eq 'arg-bridge|lark-channel-bridge|dist/cli\.js' "$path"
}

clean_command_path() {
  path="$1"
  if [ -L "$path" ]; then
    printf 'Removing existing npm command link: %s\n' "$path"
    rm -f "$path"
  elif is_legacy_launcher "$path"; then
    printf 'Removing legacy arg-bridge launcher: %s\n' "$path"
    rm -f "$path"
  fi
}

cleanup() {
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
  fi
}

trap cleanup 0
trap 'exit 1' 1 2 15

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      require_value "$1" "${2-}"
      VERSION="$2"
      shift 2
      ;;
    --archive)
      require_value "$1" "${2-}"
      ARCHIVE="$2"
      shift 2
      ;;
    --checksum)
      require_value "$1" "${2-}"
      CHECKSUM="$2"
      shift 2
      ;;
    --prefix)
      require_value "$1" "${2-}"
      PREFIX="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

[ -z "$ARCHIVE" ] || [ -z "$VERSION" ] || \
  die "--archive and --version cannot be used together"
[ -n "$ARCHIVE" ] || [ -z "$CHECKSUM" ] || \
  die "--checksum requires --archive"

command -v node >/dev/null 2>&1 || die "Node.js is required"
command -v npm >/dev/null 2>&1 || die "npm is required"

NODE_VERSION="$(node --version)"
if ! node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit(major > 20 && major < 25 || major === 20 && minor >= 12 ? 0 : 1);
'; then
  die "Node.js >= 20.12.0 and < 25 is required; found $NODE_VERSION"
fi

if [ -n "$ARCHIVE" ]; then
  [ -f "$ARCHIVE" ] || die "archive not found: $ARCHIVE"
  if [ -n "$CHECKSUM" ]; then
    [ -f "$CHECKSUM" ] || die "checksum not found: $CHECKSUM"
    verify_archive "$ARCHIVE" "$CHECKSUM"
  else
    printf 'Using local archive without checksum verification: %s\n' "$ARCHIVE"
  fi
else
  TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/arg-bridge-install.XXXXXX")"
  if [ -n "$VERSION" ]; then
    VERSION="${VERSION#v}"
    case "$VERSION" in
      ''|*[!0-9A-Za-z._-]*) die "invalid version: $VERSION" ;;
    esac
    ASSET_NAME="arg-bridge-$VERSION.tgz"
    RELEASE_BASE="https://github.com/$REPOSITORY/releases/download/v$VERSION"
  else
    ASSET_NAME="arg-bridge.tgz"
    RELEASE_BASE="https://github.com/$REPOSITORY/releases/latest/download"
  fi

  ARCHIVE="$TEMP_DIR/$ASSET_NAME"
  CHECKSUM="$TEMP_DIR/$ASSET_NAME.sha256"
  printf 'Downloading %s\n' "$RELEASE_BASE/$ASSET_NAME"
  download "$RELEASE_BASE/$ASSET_NAME" "$ARCHIVE"
  download "$RELEASE_BASE/$ASSET_NAME.sha256" "$CHECKSUM"
  verify_archive "$ARCHIVE" "$CHECKSUM"
fi

if [ -n "$PREFIX" ]; then
  mkdir -p "$PREFIX"
  GLOBAL_PREFIX="$PREFIX"
  GLOBAL_ROOT="$(npm root --global --prefix "$PREFIX")"
else
  GLOBAL_PREFIX="$(npm prefix --global)"
  GLOBAL_ROOT="$(npm root --global)"
fi

clean_broken_link "$GLOBAL_ROOT/arg-bridge"
clean_command_path "$GLOBAL_PREFIX/bin/arg-bridge"
clean_command_path "$GLOBAL_PREFIX/bin/lark-channel-bridge"

if [ -n "$PREFIX" ]; then
  npm install --global --ignore-scripts --install-links=true \
    --prefix "$PREFIX" "$ARCHIVE"
else
  npm install --global --ignore-scripts --install-links=true "$ARCHIVE"
fi

ARG_BRIDGE_BIN="$GLOBAL_PREFIX/bin/arg-bridge"
[ -x "$ARG_BRIDGE_BIN" ] || die "installed command is missing: $ARG_BRIDGE_BIN"

INSTALLED_VERSION="$($ARG_BRIDGE_BIN --version)"
printf 'Installed arg-bridge %s at %s\n' "$INSTALLED_VERSION" "$ARG_BRIDGE_BIN"

case ":${PATH-}:" in
  *":$GLOBAL_PREFIX/bin:"*) ;;
  *)
    printf 'Add this directory to PATH before running arg-bridge:\n'
    printf '  export PATH="%s/bin:$PATH"\n' "$GLOBAL_PREFIX"
    ;;
esac
