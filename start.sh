#!/bin/sh
# Opens Photo Cleaner at http://127.0.0.1:8770 (macOS or Linux)
cd "$(dirname "$0")"
[ -x .venv/bin/python ] || ./setup.sh || exit 1
exec .venv/bin/python app.py "$@"
