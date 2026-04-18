#!/usr/bin/env bash
set -e

VERSION=$(grep '"version"' manifest.json | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+')
OUT="gemini-chat-backup-v${VERSION}.zip"

rm -f "$OUT"

zip -r "$OUT" \
  manifest.json \
  background.js \
  content.js \
  sidebar_scanner.js \
  popup.html \
  popup.js \
  i18n.js \
  i18n/ \
  icon.png \
  icon.svg

echo "Packed: $OUT ($(du -sh "$OUT" | cut -f1))"
