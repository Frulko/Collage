#!/usr/bin/env bash
# Downloads the Unsplash test photos listed in scripts/photos.tsv into test-photos/ (1600 px wide, JPEG).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-photos
while IFS=$'\t' read -r id _; do
  [ -z "$id" ] && continue
  out="test-photos/unsplash-${id:0:10}.jpg"
  [ -f "$out" ] || curl -fsSL "https://images.unsplash.com/photo-${id}?w=1600&q=80&fm=jpg&fit=max" -o "$out"
done < scripts/photos.tsv
echo "$(ls test-photos/*.jpg | wc -l | tr -d ' ') photos in test-photos/"
