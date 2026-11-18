"""Step 1: find every photo and video in the photos folder and make previews.

Read-only on the person's files. For each file it records size, sha256, dimensions, a perceptual
hash (for look-alikes), sharpness/brightness numbers, and the Google Takeout sidecar data
(date taken, location, and the photo's link in Google Photos).
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import time

import imagehash
from PIL import Image, ImageFilter, ImageOps, ImageStat

from . import db
from .pool import prefetch
from .config import IMG, PREVIEW_SIZE, PREVIEWS, SCAN_THREADS, THUMB_SIZE, THUMBS, VID, VIDEO_MAX_S

try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:
    pass

Image.MAX_IMAGE_PIXELS = 400_000_000  # big panoramas are fine
FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

EDITED = re.compile(r"-(edited|bearbeitet|modifié|editado|modificato|bewerkt|redigerad|muokattu)$", re.I)
NUMBERED = re.compile(r"^(.*?)\((\d+)\)$")


# ---------- Google Takeout sidecars ----------

class Sidecars:
    """Takeout writes '<name>.supplemental-metadata.json' (or older '<name>.json'), cut to 51 characters,
    and moves the '(1)' of duplicate names to the end: 'IMG_1(1).JPG' -> 'IMG_1.JPG.supplemental-metadata(1).json'."""

    def __init__(self):
        self.dirs = {}

    def _index(self, d):
        if d not in self.dirs:
            idx = {}
            try:
                names = os.listdir(d)
            except OSError:
                names = []
            for f in names:
                if not f.lower().endswith(".json"):
                    continue
                core = f[:-5]
                m = NUMBERED.match(core)
                num = m.group(2) if m else None
                core = m.group(1) if m else core
                idx.setdefault(core[:8].lower(), []).append((core.lower(), num, os.path.join(d, f)))
            self.dirs[d] = idx
        return self.dirs[d]

    def find(self, path):
        d, name = os.path.split(path)
        for exact in (name + ".supplemental-metadata.json", name + ".json"):  # also covers real names like 'x(0).jpg'
            if os.path.exists(os.path.join(d, exact)):
                return os.path.join(d, exact)
        stem, ext = os.path.splitext(name)
        m = NUMBERED.match(stem)
        num = m.group(2) if m else None
        stem = EDITED.sub("", m.group(1) if m else stem)
        full = (stem + ext + ".supplemental-metadata").lower()
        best = None
        for core, n, p in self._index(d).get(full[:8], []):
            if n != num:
                continue
            if full.startswith(core) or core == stem.lower():
                if best is None or len(core) > best[0]:
                    best = (len(core), p)
        return best[1] if best else None


def read_sidecar(p):
    try:
        with open(p, encoding="utf-8") as f:
            j = json.load(f)
    except Exception:
        return {}
    out = {}
    ts = (j.get("photoTakenTime") or {}).get("timestamp")
    if ts and str(ts).isdigit() and int(ts) > 0:
        out["taken"] = int(ts)
    for key in ("geoData", "geoDataExif"):  # Google's location, else the one the camera saved
        g = j.get(key) or {}
        if g.get("latitude") or g.get("longitude"):
            out["lat"], out["lon"] = g.get("latitude"), g.get("longitude")
            break
    if isinstance(j.get("url"), str) and j["url"].startswith("http"):
        out["gurl"] = j["url"]
    names = [p.get("name", "").strip() for p in (j.get("people") or []) if isinstance(p, dict)]
    if any(names):
        out["g_people"] = json.dumps([n for n in names if n])
    out["favorite"] = 1 if j.get("favorited") else 0
    o = j.get("googlePhotosOrigin") or {}
    app = ((j.get("appSource") or {}).get("androidPackageName") or "").lower()
    folder = str(((o.get("mobileUpload") or {}).get("deviceFolder") or {}).get("localFolderName") or "").lower()
    if "fromSharedAlbum" in o or "fromPartnerSharing" in o:
        out["origin"], out["in_storage"] = "shared_album", 0
    elif "composition" in o:
        out["origin"] = "creation_auto" if str((o["composition"] or {}).get("type", "")).upper() == "AUTO" else "creation_manual"
    elif "whatsapp" in folder or "whatsapp" in app:
        out["origin"] = "whatsapp"
    elif "quick share" in folder or "nearby" in folder:
        out["origin"] = "quick_share"
    elif "snapchat" in app or "instagram" in folder or "telegram" in folder:
        out["origin"] = "social_app"
    elif "webUpload" in o:
        out["origin"] = "web"
    elif "mobileUpload" in o:
        out["origin"] = "camera" if not folder or "camera" in folder or "dcim" in folder else "phone_folder"
    return out


# ---------- image helpers ----------

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def square(im, size=THUMB_SIZE):
    s = min(im.size)
    left, top = (im.width - s) // 2, (im.height - s) // 2
    return im.crop((left, top, left + s, top + s)).resize((size, size), Image.LANCZOS)


def metrics(im):
    """Brightness, contrast and sharpness (variance of the Laplacian) on a 512px grey copy."""
    g = im.convert("L")
    g.thumbnail((512, 512))
    st = ImageStat.Stat(g)
    lap = g.filter(ImageFilter.Kernel((3, 3), [0, 1, 0, 1, -4, 1, 0, 1, 0], scale=1, offset=128))
    return {"bright": round(st.mean[0], 1), "contrast": round(st.stddev[0], 1),
            "sharp": round(ImageStat.Stat(lap).var[0], 1)}


def exif_time(im):
    try:
        ex = im.getexif()
        v = ex.get_ifd(0x8769).get(36867) or ex.get(306)
        if v:
            return int(time.mktime(time.strptime(str(v).strip()[:19], "%Y:%m:%d %H:%M:%S")))
    except Exception:
        pass
    return None


def placeholder(iid, color=(70, 70, 78)):
    Image.new("RGB", (THUMB_SIZE, THUMB_SIZE), color).save(os.path.join(THUMBS, f"{iid}.jpg"))


def photo(path, iid):
    out = {}
    with Image.open(path) as im:
        out["w"], out["h"] = im.size
        t = exif_time(im)
        if t:
            out["taken"] = t
        im.draft("RGB", (PREVIEW_SIZE * 2, PREVIEW_SIZE * 2))
        im = ImageOps.exif_transpose(im).convert("RGB")
    im.thumbnail((PREVIEW_SIZE, PREVIEW_SIZE), Image.LANCZOS)
    im.save(os.path.join(PREVIEWS, f"{iid}.jpg"), quality=85)
    square(im).save(os.path.join(THUMBS, f"{iid}.jpg"), quality=82)
    out.update(metrics(im))
    out["phash"] = str(imagehash.phash(im))
    out["frames"] = 1
    return out


def probe(path):
    """Width, height and length of a video (quick: reads only the file header)."""
    if not FFPROBE:
        return {"duration": None}
    r = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=width,height:format=duration", "-of", "json", path],
                       capture_output=True, text=True, timeout=60, creationflags=NO_WINDOW)
    j = json.loads(r.stdout or "{}")
    s = (j.get("streams") or [{}])[0]
    return {"w": s.get("width"), "h": s.get("height"),
            "duration": round(float((j.get("format") or {}).get("duration") or 0), 2)}


def video(path, iid, info):
    """Short clips only: one frame from the middle stands for the whole clip."""
    out = {"frames": 0, **info}
    preview = os.path.join(PREVIEWS, f"{iid}.jpg")
    if FFMPEG and info.get("duration") is not None:
        subprocess.run([FFMPEG, "-v", "error", "-y", "-ss", f"{info['duration'] / 2:.2f}", "-i", path, "-frames:v", "1",
                        "-vf", f"scale={PREVIEW_SIZE}:{PREVIEW_SIZE}:force_original_aspect_ratio=decrease", preview],
                       capture_output=True, timeout=120, creationflags=NO_WINDOW)
    if not os.path.exists(preview):
        placeholder(iid)
        return out
    out["frames"] = 1
    with Image.open(preview) as im:
        im = im.convert("RGB")
        square(im).save(os.path.join(THUMBS, f"{iid}.jpg"), quality=82)
        out.update(metrics(im))
        out["phash"] = str(imagehash.phash(im))
    return out


def poster(path, iid, info):
    """A long video: thumbnail and preview from its middle frame, nothing the models would use."""
    out = video(path, iid, info) if info.get("duration") is not None else dict(info)
    return {k: v for k, v in out.items() if k in ("w", "h", "duration")}


def posters(stop, progress):
    """Long videos scanned before they got thumbnails."""
    todo = [r for r in db.rows("SELECT id, path, duration FROM items WHERE status='skipped' AND duration IS NOT NULL "
                               "AND alias_of IS NULL ORDER BY id")
            if not os.path.exists(os.path.join(THUMBS, f"{r['id']}.jpg"))]
    done = 0
    for _ in prefetch(lambda r: None if stop.is_set() else poster(r["path"], r["id"], {"duration": r["duration"]}),
                      todo, ahead=SCAN_THREADS * 4, threads=SCAN_THREADS):
        done += 1
        if done % 25 == 0 or done == len(todo):
            progress(done, len(todo), f"Thumbnails for long videos: {done:,} of {len(todo):,}")


# ---------- the scan ----------

def discover():
    """Add every media file under the photos folder to the database (new files only)."""
    root = db.input_dir()
    if not os.path.isdir(root):
        return 0
    found = []
    for dp, _, fs in os.walk(root):
        for f in fs:
            ext = os.path.splitext(f)[1].lower()
            if f.startswith("._") or ext not in IMG | VID:
                continue
            p = os.path.join(dp, f)
            try:
                st = os.stat(p)
            except OSError:
                continue
            found.append((p, f, os.path.relpath(dp, root), ext, "video" if ext in VID else "photo",
                          st.st_size, st.st_mtime))
    db.write_many("INSERT OR IGNORE INTO items(path, name, folder, ext, kind, bytes, mtime) VALUES(?,?,?,?,?,?,?)",
                  found)
    return len(found)


def update(rec):
    iid = rec.pop("id")
    keys = list(rec)
    return f"UPDATE items SET {', '.join(k + '=?' for k in keys)} WHERE id=?", [rec[k] for k in keys] + [iid]


def run(stop, progress):
    progress(0, 0, "Looking for photos and videos in " + db.input_dir() + " ...")
    n = discover()
    # the video length limit may have changed since last time: re-check skipped and kept videos
    db.write("UPDATE items SET status='new' WHERE status='skipped' AND duration IS NOT NULL AND duration < ?",
             (VIDEO_MAX_S,))
    db.write("""UPDATE items SET status='skipped', decision=NULL, bucket=NULL, reason=NULL
                WHERE kind='video' AND status='scanned' AND duration >= ?""", (VIDEO_MAX_S,))
    todo = db.rows("SELECT id, path, kind FROM items WHERE status='new' ORDER BY id")
    if not n:
        progress(0, 0, "No photos or videos found in " + db.input_dir() + ". Pick your photos folder in Settings.")
        return
    sidecars = Sidecars()

    def work(it):
        if stop.is_set():
            return None
        rec = {"id": it["id"]}
        try:
            if it["kind"] == "video":
                info = probe(it["path"])
                if info["duration"] is None or info["duration"] >= VIDEO_MAX_S:
                    # long videos aren't judged by the models: just a frame from the middle, for you to decide
                    rec.update(poster(it["path"], it["id"], info), status="skipped")
                else:
                    rec["sha256"] = sha256(it["path"])
                    rec.update(video(it["path"], it["id"], info), status="scanned")
            else:
                rec["sha256"] = sha256(it["path"])
                rec.update(photo(it["path"], it["id"]), status="scanned")
        except Exception as e:
            rec["status"], rec["scan_error"] = "error", str(e)[:300]
            placeholder(it["id"], (110, 60, 60))
        sc = sidecars.find(it["path"])
        if sc:
            rec.update(read_sidecar(sc))  # Google's date wins over EXIF
        return rec

    done, total = 0, len(todo)
    progress(0, total, f"Scanning {total:,} new files...")
    batch = []
    for rec in prefetch(work, todo, ahead=SCAN_THREADS * 4, threads=SCAN_THREADS):
        if rec is None:
            continue
        batch.append(rec)
        done += 1
        if len(batch) >= 25:
            for r in batch:
                db.write(*update(r))
            batch = []
            progress(done, total, f"Scanned {done:,} of {total:,}")
    for r in batch:
        db.write(*update(r))
    progress(done, total, f"Scanned {done:,} files")
    posters(stop, progress)
