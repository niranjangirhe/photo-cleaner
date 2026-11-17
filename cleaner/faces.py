"""Step 3: find faces in every photo (SCRFD) and make a fingerprint of each face (ArcFace).
Both models come from InsightFace's buffalo_l pack and run with onnxruntime on the processor,
which is fast enough (tens of milliseconds a photo) and needs no CUDA setup."""
import os
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np
import onnxruntime as ort

from . import db
from .config import FACE_DIR, FACE_MIN_PX, FACES, PREVIEWS

# where the eyes, nose and mouth corners sit in a 112x112 ArcFace input
ARC_DST = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
                    [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float32)


def _session(path):
    so = ort.SessionOptions()
    so.log_severity_level = 3
    return ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])


def nms(boxes, scores, thresh):
    x1, y1, x2, y2 = boxes.T
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(i)
        xx1, yy1 = np.maximum(x1[i], x1[order[1:]]), np.maximum(y1[i], y1[order[1:]])
        xx2, yy2 = np.minimum(x2[i], x2[order[1:]]), np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0, xx2 - xx1 + 1) * np.maximum(0, yy2 - yy1 + 1)
        order = order[1:][inter / (areas[i] + areas[order[1:]] - inter) <= thresh]
    return keep


class Detector:
    SIZE = 640

    def __init__(self):
        self.s = _session(os.path.join(FACE_DIR, "det_10g.onnx"))
        self.inp = self.s.get_inputs()[0].name
        self.centers = {}

    def detect(self, img, thresh=0.5, shrink=1.0):
        """shrink < 1 leaves a border, so a face that fills the whole photo (close-up selfie) is still found."""
        h, w = img.shape[:2]
        scale = self.SIZE * shrink / max(h, w)
        nh, nw = max(1, int(round(h * scale))), max(1, int(round(w * scale)))
        canvas = np.zeros((self.SIZE, self.SIZE, 3), np.uint8)
        canvas[:nh, :nw] = cv2.resize(img, (nw, nh))
        blob = cv2.dnn.blobFromImage(canvas, 1 / 128, (self.SIZE, self.SIZE), (127.5, 127.5, 127.5), swapRB=True)
        outs = [o[0] if o.ndim == 3 else o for o in self.s.run(None, {self.inp: blob})]
        # sort the 9 outputs into scores / boxes / landmarks, finest stride first
        by = {1: [], 4: [], 10: []}
        for o in outs:
            by[o.shape[-1]].append(o)
        for k in by:
            by[k].sort(key=lambda a: -a.shape[0])
        boxes, scores, kpss = [], [], []
        for sc, bb, kp, stride in zip(by[1], by[4], by[10], (8, 16, 32)):
            n = self.SIZE // stride
            if stride not in self.centers:
                c = (np.stack(np.mgrid[:n, :n][::-1], axis=-1).astype(np.float32) * stride).reshape(-1, 2)
                self.centers[stride] = np.repeat(c, sc.shape[0] // c.shape[0], axis=0)
            c = self.centers[stride]
            pos = np.where(sc.reshape(-1) >= thresh)[0]
            if not len(pos):
                continue
            d, cc = bb[pos] * stride, c[pos]
            boxes.append(np.stack([cc[:, 0] - d[:, 0], cc[:, 1] - d[:, 1], cc[:, 0] + d[:, 2], cc[:, 1] + d[:, 3]], 1))
            scores.append(sc.reshape(-1)[pos])
            kpss.append(kp[pos].reshape(-1, 5, 2) * stride + cc[:, None, :])
        if not boxes:
            return []
        boxes, scores, kpss = np.concatenate(boxes) / scale, np.concatenate(scores), np.concatenate(kpss) / scale
        return [(boxes[i], float(scores[i]), kpss[i]) for i in nms(boxes, scores, 0.4)]


class Embedder:
    def __init__(self):
        self.s = _session(os.path.join(FACE_DIR, "w600k_r50.onnx"))
        self.inp = self.s.get_inputs()[0].name

    def embed(self, img, kps_list):
        crops = []
        for kps in kps_list:
            M, _ = cv2.estimateAffinePartial2D(kps.astype(np.float32), ARC_DST, method=cv2.LMEDS)
            crops.append(cv2.warpAffine(img, M, (112, 112), borderValue=0))
        blob = cv2.dnn.blobFromImages(crops, 1 / 127.5, (112, 112), (127.5, 127.5, 127.5), swapRB=True)
        v = self.s.run(None, {self.inp: blob})[0]
        return v / np.linalg.norm(v, axis=1, keepdims=True)


def imread(path):
    """cv2.imread can't open paths with non-English characters on Windows."""
    try:
        return cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
    except Exception:
        return None


def crop(img, box, size=160):
    x1, y1, x2, y2 = box
    cx, cy, s = (x1 + x2) / 2, (y1 + y2) / 2, max(x2 - x1, y2 - y1) * 1.5
    h, w = img.shape[:2]
    a, b = int(max(0, cx - s / 2)), int(max(0, cy - s / 2))
    c, d = int(min(w, cx + s / 2)), int(min(h, cy + s / 2))
    if c <= a or d <= b:
        return None
    return cv2.resize(img[b:d, a:c], (size, size), interpolation=cv2.INTER_AREA)


def run(stop, progress):
    todo = db.rows("SELECT id FROM items WHERE status='scanned' AND alias_of IS NULL AND frames > 0 "
                   "AND faces_done=0 ORDER BY id")
    total = len(todo)
    if not total:
        return
    progress(0, total, "Loading the face models...")
    det, emb = Detector(), Embedder()
    progress(0, total, f"Looking for faces in {total:,} photos and videos...")

    def load(it):  # the preview: the photo itself, or a short video's middle frame
        return it, imread(os.path.join(PREVIEWS, f"{it['id']}.jpg"))

    done, batch = 0, []
    with ThreadPoolExecutor(4) as ex:
        for it, img in ex.map(load, todo):
            if stop.is_set():
                return
            found = []
            if img is not None:
                faces = det.detect(img) or det.detect(img, shrink=0.5)
                good = [f for f in faces if min(f[0][2] - f[0][0], f[0][3] - f[0][1]) >= FACE_MIN_PX and f[1] >= 0.6]
                vecs = emb.embed(img, [f[2] for f in good]) if good else []
                gi = 0
                for box, score, _ in faces:
                    size = float(min(box[2] - box[0], box[3] - box[1]))
                    v = None
                    if size >= FACE_MIN_PX and score >= 0.6:  # big and clear enough to recognise
                        v = vecs[gi].astype(np.float32).tobytes()
                        gi += 1
                    found.append((box, score, size, v, crop(img, box)))
            count = len(found)

            def save(c, it=it, found=found, count=count):
                for box, score, size, v, im in found:
                    cur = c.execute("INSERT INTO faces(item_id, x1, y1, x2, y2, det, size, emb) "
                                    "VALUES(?,?,?,?,?,?,?,?)", (it["id"], *map(float, box), score, size, v))
                    if im is not None:
                        cv2.imencode(".jpg", im, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tofile(
                            os.path.join(FACES, f"{cur.lastrowid}.jpg"))
                c.execute("UPDATE items SET faces_done=1, face_count=? WHERE id=?", (count, it["id"]))
                c.execute("DELETE FROM item_tags WHERE item_id=? AND tag='people'", (it["id"],))
                if count:
                    c.execute("INSERT INTO item_tags(item_id, tag, score) VALUES(?, 'people', ?)", (it["id"], count))

            db.script(save)
            done += 1
            batch.append(it["id"])
            if done % 10 == 0 or done == total:
                progress(done, total, f"Checked {done:,} of {total:,} for faces", ids=batch)
                batch = []
