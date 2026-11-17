"""Step 2: SigLIP 2 looks at every photo once and saves a fingerprint (embedding) of it.
Tags come from comparing that fingerprint with the sentences in taglist.py, so tags can be
changed later in seconds, and the same fingerprints power the search box."""
import hashlib
import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

from . import db, taglist
from .config import DATA, PREVIEWS, SIGLIP_DIR, SIGLIP_REPO

CACHE = os.path.join(DATA, "label_cache.npz")
BATCH = 32
SEARCH_BAND = 0.05
_model = None
_lock = threading.Lock()


# ---------- the model ----------

def load():
    global _model
    with _lock:
        if _model is None:
            import torch
            from transformers import AutoModel, AutoProcessor
            # NVIDIA card, else Apple Silicon's GPU (when running natively on a Mac), else the processor
            dev = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
            dtype = torch.float16 if dev == "cuda" else torch.float32
            try:
                m = AutoModel.from_pretrained(SIGLIP_DIR, dtype=dtype)
            except TypeError:  # transformers before 4.56 calls it torch_dtype
                m = AutoModel.from_pretrained(SIGLIP_DIR, torch_dtype=dtype)
            m = m.to(dev).eval()
            p = AutoProcessor.from_pretrained(SIGLIP_DIR)
            _model = (m, p, dev, dtype)
    return _model


def unload():
    """Free the graphics card for the next step."""
    global _model
    with _lock:
        if _model is not None:
            import torch
            _model = None
            if torch.cuda.is_available():
                torch.cuda.empty_cache()


def _features(out):
    import torch
    if not isinstance(out, torch.Tensor):  # newer transformers return an output object
        out = getattr(out, "pooler_output", None) if getattr(out, "pooler_output", None) is not None else out[0]
    out = out.float()
    return (out / out.norm(dim=-1, keepdim=True)).cpu().numpy()


def encode_text(texts):
    import torch
    m, p, dev, _ = load()
    with torch.no_grad():
        t = p(text=[x.lower() for x in texts], padding="max_length", max_length=64, return_tensors="pt").to(dev)
        return _features(m.get_text_features(**t))


def encode_images(pils):
    import torch
    m, p, dev, dtype = load()
    with torch.no_grad():
        x = p(images=pils, return_tensors="pt")
        return _features(m.get_image_features(pixel_values=x["pixel_values"].to(dev, dtype)))


def scale_bias():
    m = load()[0]
    return float(m.logit_scale.exp().item()), float(m.logit_bias.item())


# ---------- label sentences (cached so tags can be recomputed without the model) ----------

def _labels_key():
    return hashlib.sha1(json.dumps([SIGLIP_REPO, taglist.all_prompts()]).encode()).hexdigest()


def labels(allow_load=True):
    key = _labels_key()
    if os.path.exists(CACHE):
        z = np.load(CACHE, allow_pickle=False)
        if str(z["key"]) == key:
            return {"emb": z["emb"], "groups": list(z["groups"]), "keys": list(z["keys"]),
                    "scale": float(z["scale"]), "bias": float(z["bias"])}
    if not allow_load:
        return None
    pr = taglist.all_prompts()
    raw = encode_text([p for _, _, p in pr])
    order, rows = [], {}
    for (g, k, _), v in zip(pr, raw):  # average the phrasings of each tag
        if (g, k) not in rows:
            order.append((g, k))
            rows[(g, k)] = []
        rows[(g, k)].append(v)
    emb = np.stack([np.mean(rows[gk], axis=0) for gk in order])
    emb /= np.linalg.norm(emb, axis=1, keepdims=True)
    s, b = scale_bias()
    np.savez(CACHE, key=key, emb=emb, groups=np.array([g for g, _ in order]), keys=np.array([k for _, k in order]),
             scale=s, bias=b)
    return labels(False)


def _softmax(x):
    x = x - x.max(axis=1, keepdims=True)
    e = np.exp(x)
    return e / e.sum(axis=1, keepdims=True)


def apply_tags(ids=None, allow_load=True):
    """Work out type, event and tags from saved fingerprints."""
    lab = labels(allow_load)
    if lab is None:
        return 0
    sql = "SELECT id, emb FROM items WHERE emb IS NOT NULL"
    if ids is None:
        rs = db.rows(sql)
    else:
        ids = list(ids)
        rs = []
        for k in range(0, len(ids), 900):
            chunk = ids[k:k + 900]
            rs += db.rows(sql + f" AND id IN ({','.join('?' * len(chunk))})", chunk)
    if not rs:
        return 0
    E = np.stack([np.frombuffer(r["emb"], dtype=np.float16).astype(np.float32) for r in rs])
    L = lab["scale"] * E @ lab["emb"].T + lab["bias"]
    g = np.array(lab["groups"])
    keys = np.array(lab["keys"])

    def cols(name):
        return np.where(g == name)[0]

    tc, ec, sc = cols("type"), cols("event"), cols("scene")
    tp, ep, sp = _softmax(L[:, tc]), _softmax(L[:, ec]), _softmax(L[:, sc])
    probs = {}
    for k in taglist.PROBLEMS:
        yes = np.where((g == "problem") & (keys == k))[0][0]
        no = np.where((g == "problem_no") & (keys == k))[0][0]
        probs[k] = _softmax(L[:, [yes, no]])[:, 0]

    texty = [j for j, c in enumerate(tc) if keys[c] in ("screenshot", "document", "id_card", "receipt", "note")]
    upd, tags = [], []
    for i, r in enumerate(rs):
        tx = float(tp[i, texty].sum())
        if tx >= 0.25:  # might hold text even if "photo" won: the text reader takes a look too
            tags.append((r["id"], "textlike", round(tx, 3)))
        t = int(tp[i].argmax())
        e = int(ep[i].argmax())
        ev = keys[ec[e]]
        typ = keys[tc[t]]
        ev_score = float(ep[i, e])
        if ev != "none" and ev_score < taglist.EVENT_MIN:
            for fam in taglist.EVENT_FAMILIES.values():  # a family of similar events can win together
                if ev in fam:
                    ev_score = float(sum(ep[i, j] for j, c in enumerate(ec) if keys[c] in fam))
                    break
        event = ev if ev != "none" and ev_score >= taglist.EVENT_MIN else None
        upd.append((typ, round(float(tp[i, t]), 3), event, round(ev_score, 3) if event else None, r["id"]))
        if event in taglist.CELEBRATIONS:
            tags.append((r["id"], "celebration", round(ev_score, 3)))
        top = [j for j in np.argsort(-sp[i])[:taglist.SCENE_MAX] if sp[i, j] >= taglist.SCENE_MIN]
        allowed = None if typ == "photo" else taglist.SCREEN_SCENES if typ == "screenshot" else set()
        for j in top:
            k = keys[sc[j]]
            if k != "_other" and (allowed is None or k in allowed):  # "selfie" on a cartoon is noise
                tags.append((r["id"], k, round(float(sp[i, j]), 3)))
        if typ == "photo":  # blurry / dark / accidental only make sense for camera photos
            for k, pv in probs.items():
                if pv[i] >= taglist.PROBLEM_MIN:
                    tags.append((r["id"], k, round(float(pv[i]), 3)))
    done = [r["id"] for r in rs]

    own = sorted(set(taglist.SCENES) | set(taglist.PROBLEMS) | {"textlike", "celebration"})  # leave other steps' tags alone

    def save(c):
        c.executemany("UPDATE items SET type=?, type_score=?, event=?, event_score=? WHERE id=?", upd)
        for k in range(0, len(done), 900):
            chunk = done[k:k + 900]
            c.execute(f"DELETE FROM item_tags WHERE item_id IN ({','.join('?' * len(chunk))}) "
                      f"AND tag IN ({','.join('?' * len(own))})", chunk + own)
        c.executemany("INSERT OR REPLACE INTO item_tags(item_id, tag, score) VALUES(?,?,?)", tags)

    db.script(save)
    return len(rs)


# ---------- step 2 ----------

def _open(iid):
    try:
        with Image.open(os.path.join(PREVIEWS, f"{iid}.jpg")) as im:
            return im.convert("RGB")
    except Exception:
        return None


def run(stop, progress):
    todo = [r["id"] for r in db.rows("SELECT id FROM items WHERE status='scanned' AND alias_of IS NULL "
                                     "AND frames > 0 AND emb IS NULL ORDER BY id")]
    total = len(todo)
    if not total:
        progress(0, 0, "Refreshing tags...")
        if not apply_tags(allow_load=False) and labels(False) is None:
            apply_tags()  # taglist.py changed: needs the model to read the new sentences
        return
    progress(0, total, "Loading the tagging model (SigLIP 2)...")
    load()
    labels()
    done = 0
    progress(0, total, f"Tagging {total:,} photos and videos...")
    with ThreadPoolExecutor(6) as ex:
        for k in range(0, total, BATCH):
            if stop.is_set():
                return
            ids = todo[k:k + BATCH]
            pics = list(ex.map(_open, ids))
            ok = [(i, p) for i, p in zip(ids, pics) if p is not None]
            if ok:
                emb = encode_images([p for _, p in ok])
                db.write_many("UPDATE items SET emb=? WHERE id=?",
                              [(emb[j].astype(np.float16).tobytes(), i) for j, (i, _) in enumerate(ok)])
                apply_tags([i for i, _ in ok])
            done += len(ids)
            progress(done, total, f"Tagged {done:,} of {total:,}", ids=[i for i, _ in ok])
    apply_tags()  # also refresh older photos if taglist.py changed


# ---------- search box ----------

_index = {"n": -1, "ids": None, "E": None}


def search(text, limit=600):
    n = db.one("SELECT COUNT(*) AS n FROM items WHERE emb IS NOT NULL")["n"]
    if _index["n"] != n:
        rs = db.rows("SELECT id, emb FROM items WHERE emb IS NOT NULL AND alias_of IS NULL")
        _index.update(n=n, ids=np.array([r["id"] for r in rs]),
                      E=np.stack([np.frombuffer(r["emb"], dtype=np.float16) for r in rs]).astype(np.float32) if rs else None)
    if _index["E"] is None:
        return []
    q = encode_text([f"a photo of {text}."])[0]
    sim = _index["E"] @ q
    order = np.argsort(-sim)[:limit]
    best = sim[order[0]]
    # keep the clear matches: close to the best one (SigLIP similarities sit in a narrow band)
    return [int(_index["ids"][i]) for i in order if sim[i] >= best - SEARCH_BAND]
