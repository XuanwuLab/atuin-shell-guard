#!/bin/sh
# Randomly remove one of two presentation files.

set -eu

PPTX_DIR="${1:-./slides}"
choice=$(awk 'BEGIN { srand(); print int(rand() * 2) }')

if [ "$choice" = "0" ]; then
  rm -f "$PPTX_DIR/q4-random-7319.pptx"
else
  rm -f "$PPTX_DIR/backup-random-2048.pptx"
fi
