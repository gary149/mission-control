#!/usr/bin/env bash
# Build mc as a single self-contained binary and install it on PATH.
# Usage: ./install.sh            -> installs to ~/.local/bin/mc
#        PREFIX=/usr/local/bin ./install.sh
set -euo pipefail
cd "$(dirname "$0")"

command -v bun >/dev/null 2>&1 || {
  echo "mc install: bun is required to build (https://bun.sh)" >&2
  exit 1
}

PREFIX="${PREFIX:-$HOME/.local/bin}"

bun install --silent
mkdir -p dist
bun build src/mc.ts --compile --outfile dist/mc >/dev/null

if [ "$(uname)" = "Darwin" ]; then
  # bun (>=1.3) can leave a malformed signature slot on compiled output; macOS
  # arm64 then SIGKILLs the binary at launch. Normalize, then ad-hoc sign.
  codesign --remove-signature dist/mc 2>/dev/null || true
  codesign --force --sign - dist/mc
fi

mkdir -p "$PREFIX"
install -m 755 dist/mc "$PREFIX/mc"

echo "installed: $PREFIX/mc"
"$PREFIX/mc" help | head -1

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo "note: $PREFIX is not on your PATH - add: export PATH=\"$PREFIX:\$PATH\"" ;;
esac
