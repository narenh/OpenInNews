#!/bin/zsh
# Assembles the Chrome extension in build/chrome from the shared Safari sources.
#
#   ./scripts/build-chrome.sh
#
# Then load build/chrome at chrome://extensions with Developer mode on.
set -euo pipefail

ROOT="${0:A:h}/.."
OUT="$ROOT/build/chrome"

rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$ROOT/Extension/Resources/." "$OUT/"
cp "$ROOT/Chrome/manifest.json" "$ROOT/Chrome/sw.js" "$OUT/"

echo "Built $OUT"
