"""Runs every step in a background thread, one model at a time. Pause any time; Start picks up where it stopped.

  scan -> duplicates -> tags (SigLIP 2) -> faces (InsightFace) -> people -> text (RapidOCR) -> suggestions
"""
import collections
import os
import shutil
import threading
import time
import traceback

from . import db, download, dupes, faces, ocr, people, rules, scan, tagger
from .config import FACES, PREVIEWS, THUMBS

STEPS = [("scan", "Scan files"), ("group", "Duplicates"), ("tag", "Tags"), ("faces", "Faces"),
         ("people", "People"), ("ocr", "Read text"), ("decide", "Suggestions")]
META_TAGS = ["whatsapp", "quick_share", "social_app", "shared_album", "creation_auto", "creation_manual",
             "favorite", "google_people"]


class Runner:
    def __init__(self):
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.thread = None
        self.finished = collections.deque(maxlen=60)  # (time, done) of recent progress, for the speed
        self.recent = collections.deque(maxlen=36)  # ids the current step just finished, for the live feed
        self.state = {"phase": "idle", "done": 0, "total": 0, "message": "Pick your photos folder, then press Start.",
                      "started": None, "phase_started": None, "error": None}

    def running(self):
        return bool(self.thread and self.thread.is_alive())

    def start(self):
        with self.lock:
            if self.running():
                return False
            self.stop.clear()
            self.thread = threading.Thread(target=self._run, daemon=True)
            self.thread.start()
            return True

    def pause(self):
        self.stop.set()

    def reset(self):
        """Start over: forget every result (tags, faces, people, choices) but never touch the photos or models."""
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=180)
        if self.running():
            raise RuntimeError("Still finishing the current photo. Try again in a minute.")
        tagger.unload()

        def wipe(c):
            for t in ("items", "item_tags", "faces", "persons"):
                c.execute(f"DELETE FROM {t}")
        db.script(wipe)
        with db.write_lock:
            db.conn().execute("VACUUM")
        for d in (THUMBS, PREVIEWS, FACES):
            shutil.rmtree(d, ignore_errors=True)
            os.makedirs(d, exist_ok=True)
        if os.path.exists(tagger.CACHE):
            os.remove(tagger.CACHE)
        tagger._index["n"] = -1
        with self.lock:
            self.recent.clear()
            self.finished.clear()
            self.state = {"phase": "idle", "done": 0, "total": 0, "started": None, "phase_started": None,
                          "error": None,
                          "message": "Everything was cleared. Press Start to process your photos again."}

    def snapshot(self):
        with self.lock:
            s = dict(self.state)
            fin = list(self.finished)
        s["running"] = self.running()
        s["stopping"] = self.stop.is_set() and s["running"]
        fin = [f for f in fin if f[0] >= (s.get("phase_started") or 0)]
        # photos per minute from the real counts: steps report every 10-32 photos, not after each one
        if s["running"] and s["total"] and len(fin) >= 2 and fin[-1][0] - fin[0][0] >= 5:
            per_min = (fin[-1][1] - fin[0][1]) / (fin[-1][0] - fin[0][0]) * 60
            if per_min > 0:
                s["per_min"] = round(per_min, 1)
                s["eta_s"] = int((s["total"] - s["done"]) / per_min * 60)
        return s

    def _set(self, **kw):
        with self.lock:
            if "phase" in kw and kw["phase"] != self.state["phase"]:
                kw.setdefault("phase_started", time.time())
                kw.setdefault("done", 0)
                kw.setdefault("total", 0)
                self.finished.clear()
            self.state.update(kw)

    def _progress(self, done, total, msg, ids=None):
        with self.lock:
            if total != self.state["total"]:  # a new part of the step (e.g. long-video thumbnails)
                self.finished.clear()
            if done != self.state["done"]:
                self.finished.append((time.time(), done))
            self.state.update(done=done, total=total, message=msg)
            if ids:
                self.recent.extend(ids)
        if ids and self.state["phase"] in ("faces", "ocr"):
            rules.refresh(ids)  # photos that have everything they need get a suggestion right away

    # ----- the work -----
    def _run(self):
        self._set(started=time.time(), error=None)
        try:
            st = download.status()
            missing = [n for n, ok in (("SigLIP 2", st["siglip"]), ("face models", st["faces"]),
                                       ("RapidOCR", st["ocr"])) if not ok]
            if missing:
                self._set(phase="waiting", message=f"Missing: {', '.join(missing)}. Run the setup again to download the models.")
                return
            steps = [("scan", scan.run), ("group", self._group), ("tag", tagger.run), ("faces", faces.run),
                     ("people", people.run), ("ocr", ocr.run), ("decide", self._decide)]
            for name, fn in steps:
                self._set(phase=name, message=dict(STEPS)[name] + "...")
                fn(self.stop, self._progress)
                if name == "tag":
                    tagger.unload()  # free the graphics card for the next steps
                if self._paused():
                    return
            self._set(phase="done", message="All done. Review the suggestions below.")
        except Exception as e:
            traceback.print_exc()
            self._set(phase="error", error=str(e), message="Something went wrong: " + str(e)[:300])

    def _paused(self):
        if self.stop.is_set():
            self._set(phase="paused", message="Paused. Press Continue to carry on where it stopped.")
            return True
        return False

    def _group(self, stop, progress):
        progress(0, 0, "Finding exact copies and look-alike shots...")
        info = dupes.run()

        def meta_tags(c):  # tags straight from Google's info files, so they can be filtered like any other tag
            c.execute(f"DELETE FROM item_tags WHERE tag IN ({','.join('?' * len(META_TAGS))})", META_TAGS)
            c.execute(f"""INSERT INTO item_tags(item_id, tag, score) SELECT id, origin, 1 FROM items
                          WHERE origin IN ({','.join('?' * len(META_TAGS))})""", META_TAGS)
            c.execute("INSERT INTO item_tags(item_id, tag, score) SELECT id, 'favorite', 1 FROM items WHERE favorite=1")
            c.execute("INSERT INTO item_tags(item_id, tag, score) SELECT id, 'google_people', 1 FROM items "
                      "WHERE g_people IS NOT NULL")
        db.script(meta_tags)
        progress(1, 1, f"Found {info['groups']:,} duplicate groups")

    def _decide(self, stop, progress):
        progress(0, 0, "Working out suggestions...")
        rules.refresh()


runner = Runner()
