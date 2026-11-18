"""Step 2: work out which files are the same Google Photos item, which are true duplicates,
and which are look-alike shots (bursts, re-saved copies).

Google Takeout puts the same photo in several places: the 'Photos from 2021' folder plus every
album it is in, an '-edited' copy, and the short video half of a live photo. Those are ONE item in
Google Photos, so they are marked as aliases and hidden. They are never suggested as duplicates.
"""
import math
import os
import re

from . import db
from .config import SIMILAR_DISTANCE, SIMILAR_WINDOW_S
from .scan import EDITED, NUMBERED

YEAR_FOLDER = re.compile(r"^photos from \d{4}$", re.I)


def primary_key(it):
    """Which file stands for the item: the one in a 'Photos from YYYY' folder, not edited, shortest path."""
    stem = os.path.splitext(it["name"])[0]
    in_year = any(YEAR_FOLDER.match(p) for p in it["folder"].replace("\\", "/").split("/"))
    return (not in_year, bool(EDITED.search(stem)), len(it["path"]), it["id"])


def clean_stem(name):
    stem = os.path.splitext(name)[0]
    m = NUMBERED.match(stem)
    stem = m.group(1) if m else stem
    return EDITED.sub("", stem).lower()


class Union:
    def __init__(self):
        self.p = {}

    def find(self, a):
        self.p.setdefault(a, a)
        while self.p[a] != a:
            self.p[a] = self.p[self.p[a]]
            a = self.p[a]
        return a

    def join(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[max(ra, rb)] = min(ra, rb)


def run():
    items = db.rows("SELECT id, path, name, folder, ext, kind, bytes, sha256, phash, taken, mtime, gurl, sharp, "
                    "contrast, w, h, duration FROM items WHERE status='scanned'")
    alias = {}

    def mark_alias(group):
        group = sorted(group, key=primary_key)
        for it in group[1:]:
            alias.setdefault(it["id"], group[0]["id"])

    # 1. Same Google item: same Photos link, or same bytes with the same name (album copies)
    by = {}
    for it in items:
        if it["gurl"]:
            by.setdefault(("u", it["gurl"]), []).append(it)
        by.setdefault(("s", it["sha256"], it["name"].lower()), []).append(it)
    for g in by.values():
        if len(g) > 1:
            mark_alias(g)

    # '-edited' copies and live-photo clips belong to the photo with the same name in the same folder
    photos_by_stem = {}
    for it in items:
        if it["kind"] == "photo" and not EDITED.search(os.path.splitext(it["name"])[0]):
            photos_by_stem.setdefault((it["folder"], clean_stem(it["name"])), it)
    for it in items:
        if it["id"] in alias:
            continue
        base = photos_by_stem.get((it["folder"], clean_stem(it["name"])))
        if not base and it["kind"] == "video":  # Pixel motion photo: 'PXL_1.MP' belongs to 'PXL_1.MP.jpg'
            base = photos_by_stem.get((it["folder"], it["name"].lower()))
        if not base or base["id"] == it["id"]:
            continue
        edited = it["kind"] == "photo" and EDITED.search(os.path.splitext(it["name"])[0])
        live = it["kind"] == "video" and (it["ext"] == ".mp" or (it["duration"] or 99) <= 5)
        if edited or live:
            alias[it["id"]] = base["id"]

    alias = {a: (alias.get(b, b)) for a, b in alias.items()}  # point at the final primary
    real = [it for it in items if it["id"] not in alias]

    # 2. Exact duplicates: same bytes, different items
    groups = Union()
    by_sha = {}
    for it in real:
        by_sha.setdefault(it["sha256"], []).append(it)
    for g in by_sha.values():
        for it in g[1:]:
            groups.join(g[0]["id"], it["id"])

    # 3. Look-alikes: photos taken within a few minutes with nearly the same picture,
    #    or anywhere in the library with the identical perceptual hash (re-saved / forwarded copies)
    # (plain, near-flat pictures all hash alike, so they are left out)
    ph = [it for it in real if it["kind"] == "photo" and it["phash"] and (it["contrast"] or 0) >= 8]
    for it in ph:
        it["_h"] = int(it["phash"], 16)
        it["_t"] = it["taken"] or it["mtime"] or 0
    ph.sort(key=lambda it: it["_t"])
    for i, a in enumerate(ph):
        for b in ph[i + 1:]:
            if b["_t"] - a["_t"] > SIMILAR_WINDOW_S:
                break
            if (a["_h"] ^ b["_h"]).bit_count() <= SIMILAR_DISTANCE and a["sha256"] != b["sha256"]:
                groups.join(a["id"], b["id"])
    by_hash = {}
    for it in ph:
        by_hash.setdefault(it["_h"], []).append(it)
    for g in by_hash.values():
        for it in g[1:]:
            if it["sha256"] != g[0]["sha256"]:
                groups.join(g[0]["id"], it["id"])

    members = {}
    byid = {it["id"]: it for it in real}
    for iid in list(groups.p):
        members.setdefault(groups.find(iid), []).append(byid[iid])

    def score(it):
        return (math.log1p(it["sharp"] or 0) + 0.35 * math.log1p((it["w"] or 0) * (it["h"] or 0))
                + 0.1 * math.log1p(it["bytes"] or 0))

    dup = {}
    for root, g in members.items():
        if len(g) < 2:
            continue
        shas = {it["sha256"] for it in g}
        kind = "exact" if len(shas) == 1 else "similar"
        best = sorted(g, key=primary_key)[0] if kind == "exact" else max(g, key=score)
        for it in g:
            if it["id"] == best["id"]:
                dup[it["id"]] = (root, kind, 1)
            else:  # a spare: an exact copy of the kept one, or a look-alike of it
                dup[it["id"]] = (root, "exact" if it["sha256"] == best["sha256"] else "similar", 0)

    rows = []
    for it in items:
        g = dup.get(it["id"], (None, None, None))
        rows.append((alias.get(it["id"]), g[0], g[1], g[2], it["id"]))
    db.write_many("UPDATE items SET alias_of=?, dup_group=?, dup_kind=?, dup_best=? WHERE id=?", rows)
    long_aliases = long_videos()
    return {"aliases": len(alias) + long_aliases, "groups": sum(len(g) > 1 for g in members.values())}


def long_videos():
    """Album copies of a long video. Long videos are never read in full (no sha256), and each album copy
    has its own Google link, so the same name and size marks one video. Deleting any copy in Google
    deletes them all, so only one is shown."""
    vids = db.rows("SELECT id, path, name, folder, bytes, user_decision, gone FROM items WHERE status='skipped'")
    by = {}
    for it in vids:
        by.setdefault((it["name"].lower(), it["bytes"]), []).append(it)
    rows, moves = [], []
    for g in by.values():
        g = sorted(g, key=primary_key)
        rows.append((None, g[0]["id"]))
        rows += [(g[0]["id"], it["id"]) for it in g[1:]]
        # a choice made on a copy before copies were merged moves to the one that is shown
        chosen = next((it for it in g[1:] if it["user_decision"]), None)
        if chosen and not g[0]["user_decision"]:
            moves.append((chosen["user_decision"], chosen["gone"], g[0]["id"]))
    db.write_many("UPDATE items SET alias_of=? WHERE id=?", rows)
    db.write_many("UPDATE items SET user_decision=?, gone=? WHERE id=?", moves)
    db.write("UPDATE items SET user_decision=NULL, gone=0 WHERE status='skipped' AND alias_of IS NOT NULL")
    return sum(1 for r in rows if r[0] is not None)
