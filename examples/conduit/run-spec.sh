#!/usr/bin/env bash
# Runs the RealWorld API test suite (./spec/hurl) against Conduit on Meld.
#   ./run-spec.sh                 all files
#   ./run-spec.sh auth feed       only spec/hurl/auth.hurl and feed.hurl
# Needs bun and hurl (https://hurl.dev); override with BUN=... HURL=...
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
BUN="${BUN:-bun}"
HURL="${HURL:-hurl}"
PORT="${PORT:-8787}"
DB="$(mktemp -d)/conduit.sqlite"

"$BUN" "$ROOT/src/cli.ts" run "$DIR" --port "$PORT" --db "$DB" > "$DIR/.server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  curl -s -o /dev/null "http://localhost:$PORT/api/tags" && break
  sleep 0.1
done

FILES=()
if [ $# -eq 0 ]; then
  FILES=("$DIR"/spec/hurl/*.hurl)
else
  for name in "$@"; do FILES+=("$DIR/spec/hurl/$name.hurl"); done
fi

"$HURL" --test --jobs 1 \
  --variable "host=http://localhost:$PORT" \
  --variable "uid=$(date +%s)$$" \
  "${FILES[@]}"
