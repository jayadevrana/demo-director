#!/usr/bin/env bash
# Compile the native cursor driver to ~/.demo-director/bin/cursor.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${DEMO_DIRECTOR_HELPER:-$HOME/.demo-director/bin/cursor}"
mkdir -p "$(dirname "$OUT")"
swiftc -O -o "$OUT" native/cursor.swift
echo "built $OUT"
"$OUT" displays
