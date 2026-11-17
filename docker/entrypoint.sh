#!/bin/sh
# Downloads any missing models (only the first time), then starts the dashboard.
# A failed download doesn't stop the app: the dashboard says what's missing, and a restart retries.
python -m cleaner.download || echo "Some models couldn't be downloaded yet. Restart the container to retry."
echo "Open http://127.0.0.1:${PORT:-8770} in your browser."
exec python app.py --no-browser
