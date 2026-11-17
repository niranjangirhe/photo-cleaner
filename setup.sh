#!/bin/sh
# One-time setup on macOS or Linux: Python packages, then the models (about 5 GB). Safe to run again.
set -e
cd "$(dirname "$0")"
PY=$(command -v python3 || true)
if [ -z "$PY" ]; then echo "Python 3.10 or newer is missing. macOS: brew install python   Linux: your package manager"; exit 1; fi
[ -x .venv/bin/python ] || "$PY" -m venv .venv
.venv/bin/python -m pip install -q --upgrade pip
if [ "$(uname)" = "Darwin" ] || command -v nvidia-smi >/dev/null 2>&1; then
  echo "Installing PyTorch (uses the Mac's graphics chip or an NVIDIA card)..."
  .venv/bin/python -m pip install -q torch
else
  echo "Installing the processor-only PyTorch..."
  .venv/bin/python -m pip install -q torch --index-url https://download.pytorch.org/whl/cpu
fi
echo "Installing the other packages..."
.venv/bin/python -m pip install -q -r requirements.txt
echo "Downloading the models..."
.venv/bin/python -m cleaner.download --ollama || { echo "A model download failed. Run ./setup.sh again to retry."; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || echo "Optional: install ffmpeg so short videos can be checked (macOS: brew install ffmpeg)"
command -v ollama >/dev/null 2>&1 || echo "Optional: install Ollama from ollama.com for the AI second opinion, then run ./setup.sh again."
echo "Setup done. Next: ./start.sh"
