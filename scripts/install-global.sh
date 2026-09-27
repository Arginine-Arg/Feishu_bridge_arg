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
  --node PATH        Node binary or bin directory to run arg-bridge with.
  -h, --help         Show this help.

Environment:
  ARG_BRIDGE_NODE            Same as --node (takes precedence over PATH).
  ARG_BRIDGE_NODE_VERSION    Pin the isolated Node LTS fetched when no
                             compatible runtime is available (e.g. v22.14.0).
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
    --node)
      require_value "$1" "${2-}"
      ARG_BRIDGE_NODE="$2"
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

# ── runtime selection ────────────────────────────────────────────────────────
# arg-bridge supports Node >= 20.12 < 27. Distributions and Conda environments
# often put a much newer Node first on PATH, so prefer a dedicated compatible
# runtime over PATH and fall back to an isolated LTS download.
NODE_MIN_MAJOR=20
NODE_MIN_MINOR=12
NODE_MAX_MAJOR_EXCLUSIVE=27

node_is_compatible() {
  "$1" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    const ok = (major > 20 && major < 27) || (major === 20 && minor >= 12);
    process.exit(ok ? 0 : 1);
  ' >/dev/null 2>&1
}

node_bin_dir_of() {
  candidate="$1"
  [ -n "$candidate" ] || return 1
  if [ -d "$candidate" ]; then
    dir="$candidate"
  else
    [ -x "$candidate" ] || return 1
    dir="$(dirname "$candidate")"
  fi
  [ -x "$dir/node" ] || return 1
  # npm must come from the same runtime, otherwise `npm install` would run
  # under a different Node than the CLI uses.
  [ -x "$dir/npm" ] || return 1
  node_is_compatible "$dir/node" || return 1
  printf '%s' "$dir"
}

pick_node_runtime() {
  for candidate in \
    "${ARG_BRIDGE_NODE:-}" \
    "$HOME/.arg-bridge/node/bin" \
    "$HOME/.lark-channel/node/bin" \
    "$HOME/node/bin" \
    $(ls -d "$HOME"/software/node-v20*/bin "$HOME"/software/node-v21*/bin \
        "$HOME"/software/node-v22*/bin "$HOME"/software/node-v23*/bin \
        "$HOME"/software/node-v24*/bin "$HOME"/software/node-v25*/bin \
        "$HOME"/software/node-v26*/bin 2>/dev/null | sort -Vr)
  do
    dir="$(node_bin_dir_of "$candidate" 2>/dev/null || true)"
    if [ -n "$dir" ]; then
      printf '%s' "$dir"
      return 0
    fi
  done
  dir="$(node_bin_dir_of "$(command -v node 2>/dev/null || true)" 2>/dev/null || true)"
  [ -n "$dir" ] || return 1
  printf '%s' "$dir"
}

node_platform() {
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) os=linux ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    armv7l) arch=armv7l ;;
    *) arch=x64 ;;
  esac
  printf '%s-%s' "$os" "$arch"
}

install_isolated_node() {
  base="$HOME/.arg-bridge"
  platform="$(node_platform)"
  version="${ARG_BRIDGE_NODE_VERSION:-}"
  if [ -z "$version" ] && command -v node >/dev/null 2>&1; then
    version="$(download https://nodejs.org/dist/index.json - 2>/dev/null \
      | node -e '
          let raw = "";
          process.stdin.on("data", chunk => { raw += chunk; });
          process.stdin.on("end", () => {
            try {
              const lts = JSON.parse(raw).find(item => item.lts && /^v(22|24)\./.test(item.version));
              if (lts) process.stdout.write(lts.version);
            } catch { /* keep the pinned fallback */ }
          });
        ' 2>/dev/null || true)"
  fi
  [ -n "$version" ] || version="v22.14.0"
  target="$base/node-$version-$platform"
  if [ -x "$target/bin/node" ]; then
    printf '%s' "$target/bin"
    return 0
  fi
  case "$version" in
    v[0-9]*) ;;
    *) die "invalid ARG_BRIDGE_NODE_VERSION: $version" ;;
  esac
  mkdir -p "$base"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/arg-bridge-node.XXXXXX")"
  archive="$tmp/node.tar.gz"
  printf 'Downloading Node.js %s (%s) into %s\n' "$version" "$platform" "$target"
  download "https://nodejs.org/dist/$version/node-$version-$platform.tar.gz" "$archive" \
    || die "failed to download Node.js $version for $platform"
  if download "https://nodejs.org/dist/$version/SHASUMS256.txt" "$tmp/SHASUMS256.txt" 2>/dev/null; then
    expected="$(grep "node-$version-$platform.tar.gz\$" "$tmp/SHASUMS256.txt" | awk '{print $1}' | head -1)"
    actual="$(sha256_file "$archive")"
    if [ -n "$expected" ] && [ "$expected" != "$actual" ]; then
      rm -rf "$tmp"
      die "Node.js archive checksum mismatch for $version ($platform)"
    fi
  fi
  mkdir -p "$target"
  tar -xzf "$archive" --strip-components=1 -C "$target" \
    || { rm -rf "$tmp" "$target"; die "failed to extract Node.js $version"; }
  rm -rf "$tmp"
  [ -x "$target/bin/node" ] && [ -x "$target/bin/npm" ] \
    || die "isolated Node.js install is incomplete: $target"
  printf '%s' "$target/bin"
}

NODE_BIN_DIR="$(pick_node_runtime 2>/dev/null || true)"
if [ -z "$NODE_BIN_DIR" ]; then
  printf 'No compatible Node.js (>= %s.%s < %s) on PATH; installing an isolated LTS runtime.\n' \
    "$NODE_MIN_MAJOR" "$NODE_MIN_MINOR" "$NODE_MAX_MAJOR_EXCLUSIVE"
  NODE_BIN_DIR="$(install_isolated_node)"
fi
PATH="$NODE_BIN_DIR:$PATH"
export PATH
NODE_VERSION="$(node --version)"
node_is_compatible "$NODE_BIN_DIR/node" \
  || die "Node.js >= 20.12.0 and < 27 is required; found $NODE_VERSION in $NODE_BIN_DIR"
printf 'Using Node.js %s (%s)\n' "$NODE_VERSION" "$NODE_BIN_DIR"

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
# Remember the command links so a failed upgrade can put them back.
BACKUP_LINK_ARG_BRIDGE=""
BACKUP_LINK_LARK=""
if [ -L "$GLOBAL_PREFIX/bin/arg-bridge" ]; then
  BACKUP_LINK_ARG_BRIDGE="$(readlink "$GLOBAL_PREFIX/bin/arg-bridge")"
fi
if [ -L "$GLOBAL_PREFIX/bin/lark-channel-bridge" ]; then
  BACKUP_LINK_LARK="$(readlink "$GLOBAL_PREFIX/bin/lark-channel-bridge")"
fi
clean_command_path "$GLOBAL_PREFIX/bin/arg-bridge"
clean_command_path "$GLOBAL_PREFIX/bin/lark-channel-bridge"

# Keep the previous installation so a failed upgrade cannot leave a half
# updated bridge behind: it is restored automatically on any error below.
BACKUP_DIR=""
restore_previous_installation() {
  status=$?
  trap - 0 1 2 15
  cleanup
  if [ "$status" -ne 0 ] && [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
    rm -rf "$GLOBAL_ROOT/arg-bridge"
    mv "$BACKUP_DIR" "$GLOBAL_ROOT/arg-bridge"
    if [ -n "$BACKUP_LINK_ARG_BRIDGE" ]; then
      ln -sf "$BACKUP_LINK_ARG_BRIDGE" "$GLOBAL_PREFIX/bin/arg-bridge"
    fi
    if [ -n "$BACKUP_LINK_LARK" ]; then
      ln -sf "$BACKUP_LINK_LARK" "$GLOBAL_PREFIX/bin/lark-channel-bridge"
    fi
    printf 'arg-bridge installer: upgrade failed; restored the previous installation.\n' >&2
  fi
  exit "$status"
}
if [ -d "$GLOBAL_ROOT/arg-bridge" ]; then
  BACKUP_DIR="$GLOBAL_ROOT/.arg-bridge-backup-$$"
  rm -rf "$BACKUP_DIR"
  mv "$GLOBAL_ROOT/arg-bridge" "$BACKUP_DIR"
fi
trap restore_previous_installation 0 1 2 15

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

if [ -n "$BACKUP_DIR" ]; then
  rm -rf "$BACKUP_DIR"
  BACKUP_DIR=""
fi
trap cleanup 0
trap 'exit 1' 1 2 15

case ":${PATH-}:" in
  *":$GLOBAL_PREFIX/bin:"*) ;;
  *)
    printf 'Add this directory to PATH before running arg-bridge:\n'
    printf '  export PATH="%s/bin:$PATH"\n' "$GLOBAL_PREFIX"
    ;;
esac
