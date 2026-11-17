"""Photo Cleaner: finds photos you can delete from a Google Photos export, using open models on your own computer.

  python app.py               open the dashboard (http://127.0.0.1:8770)
  python app.py --no-browser  don't open a browser (Docker uses this)
  python app.py --start       also start processing right away
"""
import sys
import threading
import webbrowser

from cleaner import db
from cleaner.config import HOST, PORT
from cleaner.pipeline import runner
from cleaner.server import serve


def main():
    db.init()
    httpd = serve(PORT)
    url = f"http://127.0.0.1:{PORT}/"
    print(f"Photo Cleaner is running at {url}" + (f"  (listening on {HOST})" if HOST != "127.0.0.1" else ""))
    print(f"Photos folder: {db.input_dir()}  (change it in the dashboard's Settings)")
    print("Press Ctrl+C here to stop it.", flush=True)
    if "--start" in sys.argv:
        runner.start()
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping...")
        runner.pause()


if __name__ == "__main__":
    main()
