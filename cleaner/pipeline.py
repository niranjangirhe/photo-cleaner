"""Runs every step in a background thread, one model at a time. Pause any time; Start picks up where it stopped.

  scan -> duplicates -> tags (SigLIP 2) -> faces (InsightFace) -> people -> text (RapidOCR)
       -> suggestions -> second opinion (Qwen via Ollama, only for unclear blurry/dark photos)
"""
import collections
import os
import shutil
import threading
import time
import traceback
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait

from . import db, download, dupes, faces, llm, ocr, people, rules, scan, tagger
from .config import FACES, PREVIEWS, THUMBS

STEPS = [("scan", "Scan files"), ("group", "Duplicates"), ("tag", "Tags"), ("faces", "Faces"),
         ("people", "People"), ("ocr", "Read text"), ("decide", "Suggestions"), ("review", "AI second opinion")]
ITEM_COLS = "id, name, folder, ext, kind, bytes, w, h, duration, taken, frames, type, event, face_count"
META_TAGS = ["whatsapp", "quick_share", "social_app", "shared_album", "creation_auto", "creation_manual",
             "favorite", "google_people"]


class Runner:
    def __init__(self):
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.thread = None
        self.finished = collections.deque(maxlen=60)
        self.recent = collections.deque(maxlen=36)  # ids the current step just finished, for the live feed
        self.state = {"phase": "idle", "done": 0, "total": 0, "message": "Pick your photos folder, then press Start.",
                      "started": None, "phase_started": None, "working": [], "error": None}

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
                          "working": [], "error": None,
                          "message": "Everything was cleared. Press Start to process your photos again."}

    def snapshot(self):
        with self.lock:
            s = dict(self.state)
            s["working"] = list(s["working"])
            fin = list(self.finished)
        s["running"] = self.running()
        s["stopping"] = self.stop.is_set() and s["running"]
        fin = [t for t in fin if t >= (s.get("phase_started") or 0)]
        if s["running"] and s["total"] and len(fin) >= 3 and fin[-1] > fin[0]:
            per_min = (len(fin) - 1) / (fin[-1] - fin[0]) * 60
            s["per_min"] = round(per_min, 1)
            s["eta_s"] = int((s["total"] - s["done"]) / per_min * 60) if per_min else None
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
            if done != self.state["done"]:
                self.finished.append(time.time())
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
                self._set(phase="waiting", message=f"Missing: {', '.join(missing)}. Run setup.ps1 to download the models.")
                return
            steps = [("scan", scan.run), ("group", self._group), ("tag", tagger.run), ("faces", faces.run),
                     ("people", people.run), ("ocr", ocr.run), ("decide", self._decide), ("review", self._review)]
            for name, fn in steps:
                self._set(phase=name, message=dict(STEPS)[name] + "...")
                fn(self.stop, self._progress)
                if name == "tag":
                    tagger.unload()  # free the graphics card for the next steps
                if self._paused():
                    return
            self._set(phase="done", working=[], message="All done. Review the suggestions below.")
        except Exception as e:
            traceback.print_exc()
            self._set(phase="error", error=str(e), working=[], message="Something went wrong: " + str(e)[:300])

    def _paused(self):
        if self.stop.is_set():
            self._set(phase="paused", working=[], message="Paused. Press Continue to carry on where it stopped.")
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

    # ----- optional Qwen second opinion -----
    def _review(self, stop, progress):
        if not db.use_qwen():
            return
        model = db.model()
        try:
            names = llm.models()
        except llm.OllamaError:
            progress(0, 0, "Ollama isn't running, skipping the AI second opinion.")
            return
        if not llm.has(model, names):
            progress(0, 0, f"{model} isn't downloaded, skipping the AI second opinion.")
            return
        db.write("UPDATE items SET ai_error=NULL WHERE ai_error IS NOT NULL")
        todo = [r["id"] for r in db.rows("SELECT id FROM items WHERE decision='unsure' AND bucket='poor' "
                                         "AND ai_verdict IS NULL AND user_decision IS NULL ORDER BY bytes DESC")]
        total = len(todo)
        if not total:
            return
        progress(0, total, f"Qwen is taking a second look at {total:,} unclear photos")
        done, fails, it_todo = 0, 0, iter(todo)
        with ThreadPoolExecutor(db.workers()) as ex:
            running = {}

            def fill():
                while len(running) < db.workers() * 2 and not stop.is_set():
                    iid = next(it_todo, None)
                    if iid is None:
                        return
                    running[ex.submit(self._one, iid, model)] = iid

            fill()
            while running:
                self._set(working=list(running.values())[:db.workers()])
                fin, _ = wait(running, return_when=FIRST_COMPLETED)
                for f in fin:
                    self.recent.append(running.pop(f))
                    ok, err = f.result()
                    done += 1
                    fails = 0 if ok else fails + 1
                    if isinstance(err, llm.OllamaError) and fails >= 3:
                        stop.set()
                        self._set(error=str(err))
                progress(done, total, f"Second opinion on {done:,} of {total:,}")
                fill()
        self._set(working=[])

    def _one(self, iid, model):
        it = db.one(f"SELECT {ITEM_COLS} FROM items WHERE id=?", (iid,))
        it["tags"] = [r["tag"] for r in db.rows("SELECT tag FROM item_tags WHERE item_id=? AND tag!='textlike'", (iid,))]
        if it["type"]:
            it["tags"].insert(0, it["type"])
        try:
            ans, ms = llm.analyze(it, model)
            keys = list(ans)
            db.write(f"UPDATE items SET {', '.join(k + '=?' for k in keys)}, ai_ms=?, analyzed_at=? WHERE id=?",
                     [ans[k] for k in keys] + [ms, time.time(), iid])
            rules.refresh([iid])
            return True, None
        except Exception as e:
            db.write("UPDATE items SET ai_error=? WHERE id=?", (str(e)[:300], iid))
            return False, e


runner = Runner()
