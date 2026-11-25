#!/bin/bash
# VOICEVOX 公式サイトのソースからキャラクターの一人称・二人称・紹介文を取り、hooks/characters.ts を作り直す。
# 語尾・口調の手書き分は gen-characters.py の SPEECH にある。
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
REPO=VOICEVOX/voicevox_blog
for p in $(gh api "repos/$REPO/git/trees/master?recursive=1" --jq '.tree[].path' | grep '^src/constants/characterInfos/.*\.ts$'); do
    curl -fsSL "https://raw.githubusercontent.com/$REPO/master/$p" -o "$tmp/$(basename "$p")"
done
python3 -I scripts/extract-characters.py "$tmp" > "$tmp/chars.json"
python3 -I scripts/gen-characters.py "$tmp/chars.json" > hooks/characters.ts
echo "hooks/characters.ts: $(grep -c '"me":' hooks/characters.ts) characters"
