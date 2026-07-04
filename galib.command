#!/bin/bash
# GaLib launcher (macOS) — double-click to start the web app.
set -e
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  osascript -e 'display alert "Python not installed" message "Install Python 3 from python.org and try again."'
  exit 1
fi

VENV=".venv"
if [ ! -d "$VENV" ]; then
  echo "First-run setup: creating virtual environment…"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --upgrade pip >/dev/null
  "$VENV/bin/pip" install -r requirements.txt
fi

exec "$VENV/bin/python" app.py
