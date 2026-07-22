#!/usr/bin/env bash
# Install mc as a single self-contained binary on PATH.
#
#   ./install.sh                  build from source (requires bun) -> ~/.local/bin/mc
#   ./install.sh --from-release   download the rolling `latest` release (requires
#                                 gh, authed for this repo; no bun needed)
#   PREFIX=/usr/local/bin ./install.sh
set -euo pipefail
cd "$(dirname "$0")"

PREFIX="${PREFIX:-$HOME/.local/bin}"

sign_darwin() {
  # bun's compiled output can carry a missing/malformed signature slot; macOS
  # arm64 SIGKILLs unsigned binaries at launch. Ad-hoc signing needs no
  # certificate, so we normalize + sign right here on the installing machine.
  if [ "$(uname)" = "Darwin" ]; then
    codesign --remove-signature "$1" 2>/dev/null || true
    codesign --force --sign - "$1"
    xattr -d com.apple.quarantine "$1" 2>/dev/null || true
  fi
}

if [ "${1:-}" = "--from-release" ]; then
  command -v gh >/dev/null 2>&1 || {
    echo "mc install: --from-release requires the gh CLI (repo is private; downloads need auth)" >&2
    exit 1
  }
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$arch" in
    aarch64) arch=arm64 ;;
    x86_64) arch=x64 ;;
  esac
  asset="mc-$os-$arch"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  gh release download latest --pattern "$asset" --output "$tmp/mc" --clobber
  chmod +x "$tmp/mc"
  sign_darwin "$tmp/mc"
  mkdir -p "$PREFIX"
  install -m 755 "$tmp/mc" "$PREFIX/mc"
else
  command -v bun >/dev/null 2>&1 || {
    echo "mc install: bun is required to build from source (https://bun.sh)," >&2
    echo "            or use ./install.sh --from-release to download a prebuilt binary" >&2
    exit 1
  }
  bun install --silent
  mkdir -p dist
  bun build src/mc.ts --compile --minify --outfile dist/mc >/dev/null
  sign_darwin dist/mc
  mkdir -p "$PREFIX"
  install -m 755 dist/mc "$PREFIX/mc"
fi

echo "installed: $PREFIX/mc"
"$PREFIX/mc" help | head -1

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo "note: $PREFIX is not on your PATH - add: export PATH=\"$PREFIX:\$PATH\"" ;;
esac
