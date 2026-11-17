"""Step 5: read the text in screenshots, documents, receipts and notes (RapidOCR).
Reads the original file at up to 2000px, since small text in a 1024px preview is often lost."""
import numpy as np
from PIL import Image, ImageOps

from . import db

try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:
    pass

TEXTY = ("screenshot", "document", "id_card", "receipt", "note")
_engine = None


def engine():
    global _engine
    if _engine is None:
        from rapidocr_onnxruntime import RapidOCR
        _engine = RapidOCR()
    return _engine


def read(path):
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
    im.thumbnail((2000, 2000))
    res, _ = engine()(np.asarray(im)[:, :, ::-1].copy())
    return " ".join(r[1] for r in (res or []) if r[2] >= 0.5)[:4000]


def run(stop, progress):
    q = ",".join("?" * len(TEXTY))
    todo = db.rows(f"""SELECT id, path FROM items WHERE status='scanned' AND alias_of IS NULL AND kind='photo'
        AND ocr_done=0 AND (type IN ({q}) OR id IN (SELECT item_id FROM item_tags WHERE tag='textlike')) ORDER BY id""",
                   TEXTY)
    total = len(todo)
    if not total:
        return
    progress(0, total, "Loading the text reader...")
    engine()
    batch = []
    for n, it in enumerate(todo, 1):
        if stop.is_set():
            return
        try:
            text = read(it["path"])
        except Exception:
            text = ""
        db.write("UPDATE items SET ocr_done=1, ocr_text=? WHERE id=?", (text, it["id"]))
        batch.append(it["id"])
        if n % 5 == 0 or n == total:
            progress(n, total, f"Read text in {n:,} of {total:,} screenshots and documents", ids=batch)
            batch = []
