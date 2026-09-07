#!/bin/bash
# Proof for the file-casting path on the stream host.
#
# Starts nothing and assumes nothing: point it at a running instance with
#   STREAM_UPLOAD_SECRET=<same as the server>  ./scripts/test-storage.sh [base]
#
# It uploads a file of known bytes, asks for windows out of the middle and the
# tail of it, compares them byte for byte against the source, and checks that a
# ticket minted for one scope is refused at the other.
set -u
BASE="${1:-http://127.0.0.1:7899}"
cd "$(dirname "$0")/.."

fail=0
ok()   { echo "  PASS  $1"; }
bad()  { echo "  FAIL  $1"; fail=1; }
same() { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 (got $2, wanted $3)"; fi; }

TOK=$(node -e "console.log(require('./lib/ticket').mint('11111111-1111-1111-1111-111111111111','upload'))")
STOK=$(node -e "console.log(require('./lib/ticket').mint('11111111-1111-1111-1111-111111111111','storage'))")
[ -n "$TOK" ] || { echo "no ticket minted — is STREAM_UPLOAD_SECRET set?"; exit 2; }

SRC=$(mktemp /tmp/cb-src.XXXXXX.mp4)
head -c 3000000 /dev/urandom > "$SRC"

echo "upload"
UP=$(curl -s -X POST --data-binary @"$SRC" -H "Authorization: Bearer $TOK" \
     "$BASE/api/upload?name=holiday%20clip.mp4&size=3000000")
ID=$(printf '%s' "$UP" | python3 -c "import sys,json
try: print(json.load(sys.stdin)['file']['id'])
except Exception: print('')")
if [ -n "$ID" ]; then ok "stored as $ID"; else bad "upload: $UP"; echo "$UP"; exit 1; fi
BYTES=$(printf '%s' "$UP" | python3 -c "import sys,json;print(json.load(sys.stdin)['file']['bytes'])")
same "bytes stored" "$BYTES" "3000000"

echo "scope isolation"
same "upload ticket refused at /api/storage" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOK" "$BASE/api/storage")" "401"
same "no ticket refused at /api/storage" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/storage")" "401"
same "no ticket refused at /api/upload" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST --data 'x' "$BASE/api/upload?name=a.mp4")" "401"

echo "range serving"
PART=$(mktemp /tmp/cb-part.XXXXXX)
HDR=$(mktemp /tmp/cb-hdr.XXXXXX)
curl -s -D"$HDR" -o "$PART" -H "Range: bytes=100-199" "$BASE/f/$ID"
same "status" "$(awk '/^HTTP/{print $2}' "$HDR" | tr -d '\r')" "206"
same "content-range" "$(grep -i '^content-range' "$HDR" | tr -d '\r' | awk '{print $2}')" "bytes"
same "content-length" "$(grep -i '^content-length' "$HDR" | tr -d '\r' | awk '{print $2}')" "100"
same "content-type" "$(grep -i '^content-type' "$HDR" | tr -d '\r' | awk '{print $2}')" "video/mp4"
same "accept-ranges" "$(grep -i '^accept-ranges' "$HDR" | tr -d '\r' | awk '{print $2}')" "bytes"
EXP=$(mktemp /tmp/cb-exp.XXXXXX)
python3 -c "
import sys
src, out = sys.argv[1], sys.argv[2]
open(out,'wb').write(open(src,'rb').read()[100:200])" "$SRC" "$EXP"
if cmp -s "$EXP" "$PART"; then ok "window bytes identical to source"; else bad "window bytes differ"; fi

echo "tail range (an mp4 with its moov at the end asks for this first)"
same "bytes=-500 status" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Range: bytes=-500' "$BASE/f/$ID")" "206"
same "bytes=-500 length" \
  "$(curl -s -o /dev/null -w '%{size_download}' -H 'Range: bytes=-500' "$BASE/f/$ID")" "500"

echo "whole file"
same "no Range gives 200" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/f/$ID")" "200"
same "no Range gives every byte" "$(curl -s -o /dev/null -w '%{size_download}' "$BASE/f/$ID")" "3000000"

echo "not found"
same "unknown id" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/f/deadbeefdeadbeefdeadbeefdeadbeef")" "404"
same "malformed id" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/f/../../etc/passwd")" "404"

echo "storage report"
REP=$(curl -s -H "Authorization: Bearer $STOK" "$BASE/api/storage")
same "lists the file" \
  "$(printf '%s' "$REP" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['files']))")" "1"
# The folder holds the film plus its small sidecar, so this is a range, not a
# number — pinning the exact total would be pinning the length of a uuid.
same "reports the film's bytes plus a small sidecar" \
  "$(printf '%s' "$REP" | python3 -c "
import sys, json
b = json.load(sys.stdin)['usage']['files']['bytes']
print('in range' if 3000000 <= b < 3000000 + 1024 else b)")" "in range"
same "keeps the original name" \
  "$(printf '%s' "$REP" | python3 -c "import sys,json;print(json.load(sys.stdin)['files'][0]['name'])")" "holiday clip.mp4"

echo "clearing"
same "clear tmp" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $STOK" \
     -H 'content-type: application/json' -d '{"what":"tmp"}' "$BASE/api/storage/clear")" "200"
curl -s -X POST -H "Authorization: Bearer $STOK" -H 'content-type: application/json' \
     -d "{\"ids\":[\"$ID\"]}" "$BASE/api/storage/delete" > /dev/null
same "deleted file is gone from disk" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/f/$ID")" "404"
same "storage now empty" \
  "$(curl -s -H "Authorization: Bearer $STOK" "$BASE/api/storage" | python3 -c "import sys,json;print(json.load(sys.stdin)['usage']['total_bytes'])")" "0"

rm -f "$SRC" "$PART" "$HDR" "$EXP"
echo
if [ "$fail" = "0" ]; then echo "ALL PASS"; else echo "FAILURES ABOVE"; fi
exit "$fail"
