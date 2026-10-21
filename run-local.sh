#!/usr/bin/env bash
# Run 1n9 OCR on this machine without Docker.
# Needs: Python 3.11+ and Node.js 20+.
#   ./run-local.sh            # http://127.0.0.1:8083
#   ./run-local.sh --rebuild  # rebuild the web pages after changing frontend/
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8083}"
REBUILD=0
for a in "$@"; do
  case "$a" in
    --rebuild) REBUILD=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example. Fill in LICENSE_KEY / NODE_PASSWORD there, or set things up in the browser."
fi
[ -d .venv ] || python3 -m venv .venv
.venv/bin/python -m pip install -q --disable-pip-version-check -r requirements.txt

if [ "$REBUILD" = 1 ] || [ ! -d frontend/out ]; then
  (cd frontend && npm ci --no-audit --no-fund && npm run build)
fi

export NODE_DATA_DIR="$PWD/data" NODE_FRONTEND_DIR="$PWD/frontend/out"
echo "ocr: http://127.0.0.1:$PORT   (data: $NODE_DATA_DIR)"
exec .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port "$PORT"
