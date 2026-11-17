"""Local web server for the dashboard. Listens on 127.0.0.1 only, so nothing else on the network can see it."""
import csv
import io
import json
import mimetypes
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import db, download, llm, people, rules, tagger
from .config import BROWSE_ROOTS, FACES, HOST, IMG, PREVIEWS, THUMBS, VID, WEB
from .pipeline import STEPS, runner

PERSONS = ("(SELECT group_concat(DISTINCT COALESCE(p.name, 'Person ' || p.id)) FROM faces f JOIN persons p "
           "ON p.id=f.person_id WHERE f.item_id=items.id AND p.hidden=0)")
TAGS = "(SELECT group_concat(tag) FROM item_tags WHERE item_id=items.id AND tag != 'textlike')"
# for a spare copy: the photo of its group that is being kept, so both can be shown side by side
KEEPER = ("(SELECT k.id FROM items k WHERE items.dup_best=0 AND k.dup_group=items.dup_group AND k.dup_best=1 "
          "AND k.alias_of IS NULL LIMIT 1)")
FIELDS = ("id, name, folder, kind, ext, bytes, w, h, duration, taken, mtime, type, event, face_count, description, "
          "decision, bucket, reason, user_decision, gurl, gone, dup_group, dup_kind, dup_best, frames, ai_verdict, ai_reason, "
          "origin, favorite, in_storage, g_people, "
          f"{PERSONS} AS persons, {TAGS} AS tags, {KEEPER} AS keeper")

VIEWS = {
    "delete": "decision='delete' AND user_decision IS NULL",
    "unsure": "decision='unsure' AND user_decision IS NULL",
    "keep": "((decision='keep' AND user_decision IS NULL) OR user_decision='keep')",
    "approved": "user_decision='delete' AND gone=0",   # approved, still waiting to be deleted in Google
    "deleted": "user_decision='delete' AND gone=1",    # already moved to the trash in Google Photos
    "pending": "alias_of IS NULL AND status != 'skipped' AND decision IS NULL AND user_decision IS NULL",
    "all": "alias_of IS NULL AND status != 'skipped'",
}
SORTS = {"size": "bytes DESC", "date": "COALESCE(taken, mtime) DESC", "oldest": "COALESCE(taken, mtime) ASC",
         "recent": "decided_at DESC NULLS LAST"}
BROWSER_IMG = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}
BROWSER_VID = {".mp4", ".webm", ".m4v", ".mov"}
YEAR = "strftime('%Y', COALESCE(taken, mtime), 'unixepoch')"
TEXTY = "('screenshot', 'document', 'id_card', 'receipt', 'note')"

_ollama = {"t": 0, "v": None}


def ollama_status():
    if time.time() - _ollama["t"] > 5:
        try:
            _ollama["v"] = {"ok": True, "models": llm.models()}
        except llm.OllamaError as e:
            _ollama["v"] = {"ok": False, "error": str(e), "models": []}
        _ollama["t"] = time.time()
    v = dict(_ollama["v"])
    v["model"] = db.model()
    v["model_ready"] = llm.has(v["model"], v["models"])
    v["enabled"] = db.use_qwen()
    return v


def where(q, skip=None):
    c, p = [VIEWS.get(q.get("view", "delete"), VIEWS["delete"])], []

    def add(key, sql, val=None):
        if q.get(key) and skip != key:
            c.append(sql)
            p.append(q[key] if val is None else val)

    add("bucket", "bucket=?")
    add("type", "type=?")
    if q.get("event") and skip != "event":
        c.append("event IS NULL" if q["event"] == "none" else "event=?")
        if q["event"] != "none":
            p.append(q["event"])
    add("tag", "id IN (SELECT item_id FROM item_tags WHERE tag=?)")
    add("person", "id IN (SELECT item_id FROM faces WHERE person_id=?)", int(q["person"]) if q.get("person") else None)
    add("year", f"{YEAR}=?")
    if q.get("geo") == "1":  # only photos with a location
        c.append("lat IS NOT NULL")
    if q.get("bbox") and skip != "bbox":  # an area picked on the map: south,west,north,east
        s_, w_, n_, e_ = [float(x) for x in q["bbox"].split(",")]
        c.append("lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?")
        p += [min(s_, n_), max(s_, n_), min(w_, e_), max(w_, e_)]
    if q.get("gone") in ("0", "1"):  # deleted in Google yet?
        c.append("gone=?")
        p.append(int(q["gone"]))
    if q.get("kind") in ("photo", "video") and skip != "kind":
        c.append("kind=?")
        p.append(q["kind"])
    if q.get("_ids") is not None:
        ids = q["_ids"] or [-1]
        c.append(f"id IN ({','.join(str(int(i)) for i in ids)})")
    return " AND ".join(c), p


def with_search(q):
    q = dict(q)
    if q.get("q", "").strip():
        q["_ids"] = tagger.search(q["q"].strip())
    return q


def status():
    c = db.one(f"""SELECT
        COUNT(*) AS files,
        SUM(alias_of IS NULL AND status != 'skipped') AS items,
        SUM(alias_of IS NOT NULL) AS aliases,
        SUM(status!='new') AS scanned,
        SUM(status='error') AS errors,
        SUM(status='skipped') AS skipped,
        COALESCE(SUM(CASE WHEN status='skipped' THEN bytes END), 0) AS skipped_bytes,
        COALESCE(SUM(CASE WHEN alias_of IS NULL AND status != 'skipped' THEN bytes END), 0) AS bytes,
        SUM(status='scanned' AND alias_of IS NULL AND frames > 0) AS taggable,
        SUM(emb IS NOT NULL) AS tagged,
        SUM(faces_done=1) AS faced,
        SUM(face_count > 0) AS with_faces,
        SUM(lat IS NOT NULL AND alias_of IS NULL AND status != 'skipped') AS located,
        SUM(kind='photo' AND alias_of IS NULL AND type IN {TEXTY}) AS texty,
        SUM(ocr_done=1) AS read,
        SUM(ai_verdict IS NOT NULL) AS analyzed,
        SUM(alias_of IS NULL AND status != 'skipped' AND decision IS NULL AND user_decision IS NULL) AS pending,
        SUM(decision='delete' AND user_decision IS NULL) AS s_delete,
        COALESCE(SUM(CASE WHEN decision='delete' AND user_decision IS NULL THEN bytes END), 0) AS s_delete_bytes,
        SUM(decision='unsure' AND user_decision IS NULL) AS s_unsure,
        COALESCE(SUM(CASE WHEN decision='unsure' AND user_decision IS NULL THEN bytes END), 0) AS s_unsure_bytes,
        SUM((decision='keep' AND user_decision IS NULL) OR user_decision='keep') AS keep,
        COALESCE(SUM(CASE WHEN (decision='keep' AND user_decision IS NULL) OR user_decision='keep' THEN bytes END), 0) AS keep_bytes,
        SUM(user_decision='delete' AND gone=0) AS approved,
        COALESCE(SUM(CASE WHEN user_decision='delete' AND gone=0 THEN bytes END), 0) AS approved_bytes,
        SUM(user_decision='delete' AND gone=1) AS gone,
        COALESCE(SUM(CASE WHEN user_decision='delete' AND gone=1 THEN bytes END), 0) AS gone_bytes
        FROM items""")
    c = {k: (v or 0) for k, v in c.items()}
    c["people"] = db.one("SELECT COUNT(*) AS n FROM persons WHERE hidden=0")["n"]
    c["groups"] = db.one("SELECT COUNT(DISTINCT dup_group) AS n FROM items WHERE dup_group IS NOT NULL")["n"]
    return {"run": runner.snapshot(), "steps": STEPS, "counts": c, "ollama": ollama_status(),
            "models": download.status(), "input": db.input_dir(), "workers": db.workers()}


def items(q):
    q = with_search(q)
    w, p = where(q)
    if q.get("_ids") and q.get("sort", "relevance") == "relevance":
        order = f"instr(',{','.join(map(str, q['_ids']))},', ',' || id || ',')"
    else:
        order = SORTS.get(q.get("sort", "size"), SORTS["size"])
    limit, offset = min(int(q.get("limit", 120)), 500), int(q.get("offset", 0))
    out = db.rows(f"SELECT {FIELDS} FROM items WHERE {w} ORDER BY {order}, id LIMIT ? OFFSET ?", p + [limit, offset])
    total = db.one(f"SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM items WHERE {w}", p)
    return {"items": out, "total": total["n"], "bytes": total["b"]}


def facets(q):
    q = with_search(q)
    out = {}
    for key, col in (("bucket", "bucket"), ("type", "type"), ("event", "COALESCE(event, 'none')"), ("year", YEAR)):
        w, p = where(q, skip=key)
        out[key] = db.rows(f"SELECT {col} AS k, COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM items WHERE {w} "
                           "GROUP BY k ORDER BY " + ("k DESC" if key == "year" else "b DESC"), p)
    w, p = where(q, skip="tag")
    out["tag"] = db.rows(f"SELECT t.tag AS k, COUNT(*) AS n, COALESCE(SUM(items.bytes), 0) AS b FROM item_tags t "
                         f"JOIN items ON items.id=t.item_id WHERE t.tag != 'textlike' AND {w} GROUP BY t.tag ORDER BY n DESC", p)
    return out


def geo(q):
    """Every photo with a location (in the current view and filters, ignoring the map area itself)."""
    q = with_search(q)
    w, p = where(q, skip="bbox")
    return db.rows(f"""SELECT id, lat, lon, CASE WHEN user_decision='delete' THEN 'approved'
                       WHEN user_decision='keep' THEN 'keep' ELSE COALESCE(decision, 'pending') END AS d
                       FROM items WHERE {w} AND lat IS NOT NULL LIMIT 100000""", p)


def recent():
    ids = list(runner.recent)[::-1]
    if not ids:
        rs = db.rows(f"SELECT {FIELDS} FROM items WHERE decided_at IS NOT NULL AND alias_of IS NULL "
                     "ORDER BY decided_at DESC, id DESC LIMIT 36")
        return {"step": "decide", "items": rs}
    q = ",".join("?" * len(ids))
    rs = {r["id"]: r for r in db.rows(f"SELECT {FIELDS} FROM items WHERE id IN ({q})", ids)}
    return {"step": runner.state["phase"], "items": [rs[i] for i in dict.fromkeys(ids) if i in rs]}


def groups(q):
    limit, offset = min(int(q.get("limit", 30)), 100), int(q.get("offset", 0))
    gs = db.rows("""SELECT dup_group AS g, COUNT(*) AS n, COALESCE(SUM(CASE WHEN dup_best=0 THEN bytes END), 0) AS spare
                    FROM items WHERE dup_group IS NOT NULL AND alias_of IS NULL GROUP BY dup_group
                    HAVING COUNT(*) > 1 ORDER BY spare DESC, g LIMIT ? OFFSET ?""", (limit, offset))
    total = db.one("SELECT COUNT(DISTINCT dup_group) AS n FROM items WHERE dup_group IS NOT NULL AND alias_of IS NULL")["n"]
    if gs:
        ids = [g["g"] for g in gs]
        mem = db.rows(f"SELECT {FIELDS} FROM items WHERE dup_group IN ({','.join('?' * len(ids))}) AND alias_of IS NULL "
                      "ORDER BY dup_best DESC, bytes DESC", ids)
        for g in gs:
            g["members"] = [m for m in mem if m["dup_group"] == g["g"]]
    return {"groups": gs, "total": total}


def persons(q):
    hidden = 1 if q.get("hidden") == "1" else 0
    return db.rows("""SELECT p.id, p.name, p.name_auto, p.cover_face, p.faces, p.items,
        (SELECT COUNT(DISTINCT f.item_id) FROM faces f JOIN items i ON i.id=f.item_id
         WHERE f.person_id=p.id AND i.decision='delete' AND i.user_decision IS NULL) AS to_delete
        FROM persons p WHERE hidden=? ORDER BY (p.name IS NULL), p.items DESC""", (hidden,))


def item_detail(iid):
    it = db.one(f"SELECT {FIELDS}, path, ocr_text, sharp, scan_error, ai_error, ai_ms, type_score, event_score "
                "FROM items WHERE id=?", (iid,))
    if not it:
        return None
    it["tag_scores"] = db.rows("SELECT tag, score FROM item_tags WHERE item_id=? AND tag != 'textlike' "
                               "ORDER BY score DESC", (iid,))
    it["faces"] = db.rows("""SELECT f.id, f.person_id, COALESCE(p.name, CASE WHEN p.id IS NOT NULL THEN 'Person ' || p.id END)
                             AS person FROM faces f LEFT JOIN persons p ON p.id=f.person_id
                             WHERE f.item_id=? ORDER BY f.x1""", (iid,))
    return it


def _allowed(path):
    """The folder picker only shows folders inside CLEANER_BROWSE_ROOTS when that is set (Docker)."""
    path = os.path.abspath(path)
    return not BROWSE_ROOTS or any(path == r or path.startswith(r.rstrip(os.sep) + os.sep) for r in BROWSE_ROOTS)


def _roots():
    if BROWSE_ROOTS:
        return [r for r in BROWSE_ROOTS if os.path.isdir(r)]
    if os.name == "nt":
        return [f"{d}:\\" for d in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" if os.path.isdir(f"{d}:\\")]
    return [os.path.expanduser("~"), "/"]


def folders(q):
    """Subfolders of a folder, for the dashboard's folder picker. Lists names only, never reads files."""
    path = q.get("path") or ""
    if not path:
        return {"path": "", "parent": None, "roots": _roots(), "folders": [], "media": 0}
    path = os.path.abspath(path)
    if not _allowed(path) or not os.path.isdir(path):
        return {"error": "That folder isn't available", "path": path, "roots": _roots(), "folders": [], "media": 0}
    subs, media = [], 0
    try:
        with os.scandir(path) as it:
            for e in it:
                if e.name.startswith((".", "$")):
                    continue
                try:
                    if e.is_dir():
                        subs.append({"name": e.name, "path": e.path})
                    elif os.path.splitext(e.name)[1].lower() in IMG | VID:
                        media += 1
                except OSError:
                    continue
    except OSError as e:
        return {"error": str(e), "path": path, "roots": _roots(), "folders": [], "media": 0}
    parent = os.path.dirname(path.rstrip(os.sep)) or None
    if parent == path or (parent and not _allowed(parent)):
        parent = None
    return {"path": path, "parent": parent, "roots": _roots(), "media": media,
            "folders": sorted(subs, key=lambda s: s["name"].lower())[:2000]}


def set_folder(body):
    """Switch the photos folder. Results from another folder are cleared first (the dashboard asks)."""
    path = os.path.abspath(str(body.get("path") or ""))
    if not os.path.isdir(path) or not _allowed(path):
        return 400, {"error": "That folder isn't available"}
    if os.path.normcase(path) == os.path.normcase(db.input_dir()):
        return 200, {"ok": True, "path": path}
    if runner.running():
        return 409, {"error": "Pause the current run first, then change the folder."}
    have = db.one("SELECT COUNT(*) AS n FROM items")["n"]
    if have and not body.get("reset"):
        return 409, {"needs_reset": True, "count": have}
    if have:
        runner.reset()
    db.set_setting("input", path)
    return 200, {"ok": True, "path": path}


def decide(body):
    dec = body.get("decision")
    if dec not in ("keep", "delete", None):
        raise ValueError("decision must be keep, delete or null")
    if "ids" in body:
        ids = [int(i) for i in body["ids"]][:50000]
        if not ids:
            return {"changed": 0}
        n = 0
        for k in range(0, len(ids), 900):
            chunk = ids[k:k + 900]
            n += db.write(f"UPDATE items SET user_decision=? WHERE id IN ({','.join('?' * len(chunk))})",
                          [dec] + chunk).rowcount
        return {"changed": n}
    w, p = where(with_search(body))  # everything in a view, with its filters
    if dec is not None:  # a bulk action never overrides a choice you made photo by photo
        w += " AND (user_decision IS NULL OR user_decision = ?)"
        p = p + [dec]
    return {"changed": db.write(f"UPDATE items SET user_decision=? WHERE {w}", [dec] + p).rowcount}


def export_csv():
    rs = db.rows("SELECT name, folder, bytes, taken, gurl, reason, gone, path FROM items WHERE user_decision='delete' "
                 "ORDER BY COALESCE(taken, mtime)")
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["file", "folder", "size_mb", "taken", "google_photos_link", "reason", "deleted_in_google", "local_path"])
    for r in rs:
        taken = time.strftime("%Y-%m-%d %H:%M", time.localtime(r["taken"])) if r["taken"] else ""
        w.writerow([r["name"], r["folder"], f"{(r['bytes'] or 0) / 1e6:.2f}", taken, r["gurl"] or "", r["reason"] or "",
                    "yes" if r["gone"] else "", r["path"]])
    return buf.getvalue().encode("utf-8-sig")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store" if ctype == "application/json" else "max-age=3600")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def file(self, path, ctype=None, ranges=False, cache=True):
        if not path or not os.path.isfile(path):
            return self.send(404, {"error": "not found"})
        ctype = ctype or mimetypes.guess_type(path)[0] or "application/octet-stream"
        size = os.path.getsize(path)
        m = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", "")) if ranges else None
        start, end = 0, size - 1
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "max-age=3600" if cache else "no-store")
        self.end_headers()
        if self.command == "HEAD":
            return
        try:
            with open(path, "rb") as f:
                f.seek(start)
                left = end - start + 1
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            pass

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[-1] for k, v in parse_qs(u.query).items()}
        p = u.path
        try:
            if p == "/":
                return self.file(os.path.join(WEB, "index.html"), "text/html; charset=utf-8", cache=False)
            if p.startswith("/static/"):
                f = os.path.normpath(os.path.join(WEB, p[len("/static/"):]))
                if not f.startswith(os.path.normpath(WEB) + os.sep):
                    return self.send(403, {"error": "no"})
                return self.file(f, cache=False)
            m = re.match(r"^/(thumb|preview|original|face)/(\d+)$", p)
            if m:
                return self.media(m.group(1), int(m.group(2)))
            routes = {"/api/status": status, "/api/recent": recent}
            if p in routes:
                return self.send(200, routes[p]())
            qroutes = {"/api/items": items, "/api/facets": facets, "/api/groups": groups, "/api/people": persons,
                       "/api/geo": geo, "/api/folders": folders}
            if p in qroutes:
                return self.send(200, qroutes[p](q))
            if p == "/api/item":
                it = item_detail(int(q["id"]))
                return self.send(200 if it else 404, it or {"error": "not found"})
            if p == "/api/settings":
                return self.send(200, {"model": db.model(), "workers": db.workers(), "use_qwen": db.use_qwen(),
                                       "ollama": ollama_status(), "input": db.input_dir()})
            if p == "/api/export.csv":
                return self.send(200, export_csv(), "text/csv; charset=utf-8",
                                 {"Content-Disposition": 'attachment; filename="photos-to-delete.csv"'})
            self.send(404, {"error": "not found"})
        except Exception as e:
            self.send(500, {"error": str(e)})

    def media(self, kind, iid):
        if kind == "thumb":
            return self.file(os.path.join(THUMBS, f"{iid}.jpg"), "image/jpeg")
        if kind == "preview":
            return self.file(os.path.join(PREVIEWS, f"{iid}.jpg"), "image/jpeg")
        if kind == "face":
            return self.file(os.path.join(FACES, f"{iid}.jpg"), "image/jpeg")
        it = db.one("SELECT path, ext, kind FROM items WHERE id=?", (iid,))
        if not it:
            return self.send(404, {"error": "not found"})
        if it["ext"] in BROWSER_IMG or it["ext"] in BROWSER_VID:
            ctype = "video/mp4" if it["ext"] in (".mov", ".m4v") else None
            return self.file(it["path"], ctype, ranges=True)
        return self.file(os.path.join(PREVIEWS, f"{iid}.jpg"), "image/jpeg")  # HEIC etc: browsers can't show them

    def do_POST(self):
        p = urlparse(self.path).path
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            if p == "/api/start":
                return self.send(200, {"started": runner.start()})
            if p == "/api/pause":
                runner.pause()
                return self.send(200, {"ok": True})
            if p == "/api/reset":
                runner.reset()
                return self.send(200, {"ok": True})
            if p == "/api/decide":
                return self.send(200, decide(body))
            if p == "/api/gone":
                ids = [int(i) for i in body.get("ids", [])]
                for k in range(0, len(ids), 900):
                    chunk = ids[k:k + 900]
                    db.write(f"UPDATE items SET gone=? WHERE id IN ({','.join('?' * len(chunk))})",
                             [1 if body.get("gone", True) else 0] + chunk)
                return self.send(200, {"ok": True})
            if p == "/api/person":
                pid = int(body["id"])
                if "name" in body:
                    db.write("UPDATE persons SET name=?, name_auto=0 WHERE id=?", ((body["name"] or "").strip() or None, pid))
                if "hidden" in body:
                    db.write("UPDATE persons SET hidden=? WHERE id=?", (1 if body["hidden"] else 0, pid))
                ids = [r["item_id"] for r in db.rows("SELECT DISTINCT item_id FROM faces WHERE person_id=?", (pid,))]
                if ids:
                    rules.refresh(ids)  # named / hidden people change what's protected
                return self.send(200, {"ok": True})
            if p == "/api/person/merge":
                src, dst = int(body["src"]), int(body["dst"])
                people.merge(src, dst)
                ids = [r["item_id"] for r in db.rows("SELECT DISTINCT item_id FROM faces WHERE person_id=?", (dst,))]
                if ids:
                    rules.refresh(ids)
                return self.send(200, {"ok": True})
            if p == "/api/folder":
                code, out = set_folder(body)
                return self.send(code, out)
            if p == "/api/settings":
                if body.get("model"):
                    db.set_setting("model", str(body["model"]).strip())
                if body.get("workers"):
                    db.set_setting("workers", max(1, min(8, int(body["workers"]))))
                if "use_qwen" in body:
                    db.set_setting("use_qwen", "1" if body["use_qwen"] else "0")
                _ollama["t"] = 0
                return self.send(200, {"ok": True})
            self.send(404, {"error": "not found"})
        except Exception as e:
            self.send(400, {"error": str(e)})


def serve(port):
    httpd = ThreadingHTTPServer((HOST, port), Handler)
    httpd.daemon_threads = True
    return httpd
