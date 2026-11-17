"""Step 4: group face fingerprints into people, like Google Photos' People view.

Two faces are linked when their fingerprints are close (cosine >= FACE_MATCH) and each is among
the other's nearest neighbours. Linked groups with enough faces become a person. Names given in
the dashboard are kept when the groups are rebuilt after new photos arrive."""
import json
from collections import Counter

import numpy as np

from . import db
from .config import FACE_MATCH, PERSON_MIN_FACES

K = 30


def _groups(E):
    n = len(E)
    k = min(K, n - 1)
    nbr = []
    for s in range(0, n, 2048):
        S = E[s:s + 2048] @ E.T
        for r in range(S.shape[0]):
            S[r, s + r] = -1
        idx = np.argpartition(-S, k - 1, axis=1)[:, :k] if k > 0 else np.zeros((S.shape[0], 0), int)
        for r in range(S.shape[0]):
            nbr.append({int(j) for j in idx[r] if S[r, j] >= FACE_MATCH})
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for i in range(n):
        for j in nbr[i]:
            if i in nbr[j]:
                ra, rb = find(i), find(j)
                if ra != rb:
                    parent[max(ra, rb)] = min(ra, rb)
    out = {}
    for i in range(n):
        out.setdefault(find(i), []).append(i)
    return [g for g in out.values() if len(g) >= PERSON_MIN_FACES]


def run(stop=None, progress=None):
    rs = db.rows("SELECT id, emb, person_id FROM faces WHERE emb IS NOT NULL ORDER BY id")
    if progress:
        progress(0, 0, f"Grouping {len(rs):,} faces into people...")
    named = {p["id"] for p in db.rows("SELECT id FROM persons WHERE name IS NOT NULL AND name != '' AND name_auto=0")}
    groups = _groups(np.stack([np.frombuffer(r["emb"], dtype=np.float32) for r in rs])) if len(rs) > 1 else []
    groups.sort(key=len, reverse=True)

    taken, assign, new_persons = set(), {}, []
    next_id = (db.one("SELECT MAX(id) AS m FROM persons")["m"] or 0) + 1
    for g in groups:
        prev = Counter(rs[i]["person_id"] for i in g if rs[i]["person_id"])
        pid = None
        for p, _ in prev.most_common():
            if p in named or p not in taken:  # a named person may own several groups (the user merged them)
                pid = p
                break
        if pid is None:
            pid = next_id
            next_id += 1
            new_persons.append(pid)
        taken.add(pid)
        for i in g:
            assign[rs[i]["id"]] = pid

    def save(c):
        c.execute("UPDATE faces SET person_id=NULL")
        c.executemany("UPDATE faces SET person_id=? WHERE id=?", [(p, f) for f, p in assign.items()])
        c.executemany("INSERT INTO persons(id) VALUES(?)", [(p,) for p in new_persons])
        c.execute("DELETE FROM persons WHERE id NOT IN (SELECT DISTINCT person_id FROM faces WHERE person_id IS NOT NULL)")
        recount(c)

    db.script(save)
    named_now = auto_name()
    if progress:
        progress(len(groups), len(groups), f"Found {len(groups):,} people" +
                 (f", {named_now} named from your Google Photos tags" if named_now else ""))
    return len(groups)


def auto_name():
    """Give each face group the name Google Photos used for it, when the evidence is clear.
    A photo with one Google name counts fully; a group photo with 5 names counts a fifth for each."""
    rs = db.rows("""SELECT DISTINCT f.person_id AS p, i.id AS item, i.g_people AS names FROM faces f
                    JOIN items i ON i.id=f.item_id WHERE f.person_id IS NOT NULL""")
    total, raw, weight = Counter(), {}, {}
    for r in rs:
        total[r["p"]] += 1
        try:
            names = list(dict.fromkeys(json.loads(r["names"]))) if r["names"] else []
        except ValueError:
            names = []
        for n in names:
            raw.setdefault(r["p"], Counter())[n] += 1
            weight.setdefault(r["p"], Counter())[n] += 1 / len(names)
    cands = []
    for p, c in raw.items():
        for n, k in c.items():
            if k >= 2 and k / total[p] >= 0.5 and weight[p][n] >= 1:
                cands.append((weight[p][n], k, p, n))
    cands.sort(reverse=True)
    user_named = {r["id"] for r in db.rows("SELECT id FROM persons WHERE name IS NOT NULL AND name_auto=0")}
    used_names = {r["name"] for r in db.rows("SELECT name FROM persons WHERE name_auto=0 AND name IS NOT NULL")}
    give = {}
    for _, _, p, n in cands:
        if p in user_named or p in give or n in used_names:
            continue
        give[p] = n
        used_names.add(n)

    def save(c):
        c.execute("UPDATE persons SET name=NULL, name_auto=0 WHERE name_auto=1")
        c.executemany("UPDATE persons SET name=?, name_auto=1 WHERE id=?", [(n, p) for p, n in give.items()])
    db.script(save)
    return len(give)


def recount(c):
    c.execute("""UPDATE persons SET
        faces = (SELECT COUNT(*) FROM faces WHERE person_id=persons.id),
        items = (SELECT COUNT(DISTINCT item_id) FROM faces WHERE person_id=persons.id),
        cover_face = (SELECT id FROM faces WHERE person_id=persons.id ORDER BY det * size DESC LIMIT 1)""")


def merge(src, dst):
    def go(c):
        name = c.execute("SELECT name FROM persons WHERE id=?", (dst,)).fetchone()
        if not (name and name[0]):
            other = c.execute("SELECT name FROM persons WHERE id=?", (src,)).fetchone()
            if other and other[0]:
                c.execute("UPDATE persons SET name=? WHERE id=?", (other[0], dst))
        c.execute("UPDATE faces SET person_id=? WHERE person_id=?", (dst, src))
        c.execute("DELETE FROM persons WHERE id=?", (src,))
        recount(c)
    db.script(go)
