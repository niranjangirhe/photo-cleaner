"""SQLite store. Everything is resumable: stop at any time and start again."""
import sqlite3
import threading

from .config import DB_PATH, DEFAULT_INPUT, DEFAULT_MODEL, DEFAULT_WORKERS

SCHEMA = """
CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  name TEXT, folder TEXT, ext TEXT, kind TEXT,     -- kind: photo or video
  bytes INTEGER, mtime REAL,
  status TEXT DEFAULT 'new',                       -- new, scanned, error
  scan_error TEXT,
  sha256 TEXT, phash TEXT,
  w INTEGER, h INTEGER, duration REAL, frames INTEGER DEFAULT 0,
  taken INTEGER, gurl TEXT, lat REAL, lon REAL,
  g_people TEXT,                      -- names Google Photos put on this photo (JSON list)
  favorite INTEGER DEFAULT 0,         -- starred in Google Photos
  origin TEXT,                        -- camera, whatsapp, quick_share, shared_album, web, creation_auto, creation_manual
  in_storage INTEGER DEFAULT 1,       -- 0 = from a shared album: Google doesn't count it against your storage
  sharp REAL, bright REAL, contrast REAL,
  alias_of INTEGER,                   -- same Google Photos item as another file
  dup_group INTEGER, dup_kind TEXT, dup_best INTEGER,
  -- step 2: SigLIP tags
  emb BLOB,                           -- image fingerprint (float16), kept so tags can change without re-reading photos
  type TEXT, type_score REAL,         -- photo, screenshot, document, id_card, receipt, note, meme, greeting, artwork
  event TEXT, event_score REAL,
  -- step 3: faces
  faces_done INTEGER DEFAULT 0, face_count INTEGER DEFAULT 0,
  -- step 4: text
  ocr_done INTEGER DEFAULT 0, ocr_text TEXT,
  -- step 6: optional Qwen second opinion
  description TEXT, ai_verdict TEXT, ai_reason TEXT, ai_ms INTEGER, ai_error TEXT, analyzed_at REAL,
  -- result
  decision TEXT, bucket TEXT, reason TEXT, decided_at REAL,
  user_decision TEXT, gone INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS i_status ON items(status);
CREATE INDEX IF NOT EXISTS i_sha ON items(sha256);
CREATE INDEX IF NOT EXISTS i_decision ON items(decision);
CREATE INDEX IF NOT EXISTS i_user ON items(user_decision);
CREATE INDEX IF NOT EXISTS i_group ON items(dup_group);
CREATE INDEX IF NOT EXISTS i_type ON items(type);
CREATE INDEX IF NOT EXISTS i_event ON items(event);
CREATE INDEX IF NOT EXISTS i_decided ON items(decided_at);

CREATE TABLE IF NOT EXISTS item_tags(item_id INTEGER, tag TEXT, score REAL, PRIMARY KEY(item_id, tag));
CREATE INDEX IF NOT EXISTS i_tag ON item_tags(tag);

CREATE TABLE IF NOT EXISTS faces(
  id INTEGER PRIMARY KEY, item_id INTEGER,
  x1 REAL, y1 REAL, x2 REAL, y2 REAL, det REAL, size REAL,
  emb BLOB, person_id INTEGER
);
CREATE INDEX IF NOT EXISTS i_face_item ON faces(item_id);
CREATE INDEX IF NOT EXISTS i_face_person ON faces(person_id);

CREATE TABLE IF NOT EXISTS persons(
  id INTEGER PRIMARY KEY, name TEXT, cover_face INTEGER, faces INTEGER DEFAULT 0, items INTEGER DEFAULT 0,
  hidden INTEGER DEFAULT 0,
  name_auto INTEGER DEFAULT 0         -- 1 = name taken from Google Photos' own people tags, not typed by the person
);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
"""

_local = threading.local()
write_lock = threading.Lock()


def conn():
    """One connection per thread."""
    c = getattr(_local, "c", None)
    if c is None:
        c = sqlite3.connect(DB_PATH, timeout=60, check_same_thread=False)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        _local.c = c
    return c


def init():
    c = conn()
    c.executescript(SCHEMA)
    c.commit()


def write(sql, params=()):
    with write_lock:
        c = conn()
        cur = c.execute(sql, params)
        c.commit()
        return cur


def write_many(sql, rows):
    with write_lock:
        c = conn()
        c.executemany(sql, rows)
        c.commit()


def script(fn):
    """Run fn(connection) as one transaction."""
    with write_lock:
        c = conn()
        try:
            fn(c)
            c.commit()
        except Exception:
            c.rollback()
            raise


def rows(sql, params=()):
    return [dict(r) for r in conn().execute(sql, params).fetchall()]


def one(sql, params=()):
    r = conn().execute(sql, params).fetchone()
    return dict(r) if r else None


def get_setting(k, default=None):
    r = one("SELECT v FROM settings WHERE k=?", (k,))
    return r["v"] if r else default


def set_setting(k, v):
    write("INSERT INTO settings(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, str(v)))


def model():
    return get_setting("model", DEFAULT_MODEL)


def workers():
    return max(1, min(8, int(get_setting("workers", DEFAULT_WORKERS))))


def use_qwen():
    return get_setting("use_qwen", "1") == "1"


def input_dir():
    """The photos folder picked in the dashboard (or the default one)."""
    return get_setting("input", DEFAULT_INPUT)
