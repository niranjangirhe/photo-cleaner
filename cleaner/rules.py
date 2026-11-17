"""Turns everything the models found into one suggestion per item: keep, delete or unsure.
Errs on the side of keeping: losing a memory is worse than keeping junk."""
import json
import re
import time

from . import db

# Text that means "keep this"
KEEP_WORDS = re.compile(
    r"passport|aadhaa?r|\bpan\b|permanent account|driving licen|licen[cs]e no|voter|election commission|"
    r"certificate|marksheet|mark sheet|grade sheet|transcript|degree|diploma|"
    r"insurance|policy no|prescription|diagnos|hospital|lab report|medical|"
    r"account no|a/c no|ifsc|cheque|salary|payslip|pay slip|offer letter|appointment letter|"
    r"agreement|deed|registration no|form 16|income tax|visa|birth certificate", re.I)
# Text that means "you may still need this, check"
MAYBE_WORDS = re.compile(
    r"ticket|boarding pass|\bpnr\b|booking|reservation|itinerary|invoice|warranty|guarantee|"
    r"\bbill\b|receipt no|order id|tracking", re.I)
# Text that means "this is throwaway"
JUNK_WORDS = re.compile(
    r"\botp\b|one.time password|verification code|is your code|security code|"
    r"delivered|out for delivery|arriving|order (placed|confirmed|shipped)|"
    r"payment (successful|received|done)|paid to|sent to|cashback|\d+% off|\bsale\b|offer ends|"
    r"followers|following|likes|reels|subscribe|\btyping\b|last seen|\bonline\b|forwarded|"
    r"good morning|good night|battery|wi-?fi", re.I)

EVENT_LABEL = {"pre_wedding": "Haldi, mehndi or sangeet", "baby_shower": "Baby shower", "ganesh": "Ganesh Chaturthi",
               "navratri": "Navratri / Garba", "raksha_bandhan": "Raksha Bandhan", "new_year": "New Year",
               "festival": "Festival", "eid": "Eid", "diwali": "Diwali", "holi": "Holi"}
TYPE_LABEL = {"photo": "Photo", "screenshot": "Screenshot", "document": "Document", "id_card": "ID card",
              "receipt": "Receipt", "note": "Note", "meme": "Meme", "greeting": "Greeting", "artwork": "Artwork"}


def _match(rx, text):
    m = rx.search(text or "")
    return m.group(0).lower() if m else None


def decide(it, tags, known):
    """Returns (decision, bucket, reason). decision None = not ready yet."""
    if it["alias_of"]:
        return None, None, None
    if it["favorite"]:
        return "keep", "favorite", "Marked as a favorite in Google Photos"
    known = known or bool(it["g_people"])  # Google itself recognised a person you named
    d = _decide(it, tags, known)
    if d[0] == "delete" and it["origin"] == "shared_album":
        return "unsure", "shared", d[2] + ". It's from a shared album, so deleting it won't free your storage"
    return d


def _decide(it, tags, known):
    if it["status"] == "error":
        return "unsure", "unreadable", "Could not open this file, check it yourself"
    if it["status"] != "scanned":
        return None, None, None
    if it["origin"] == "creation_auto" and not it["user_decision"]:
        return "delete", "creation", "Collage or animation Google made automatically"

    typ = it["type"]
    texty = typ in ("screenshot", "document", "id_card", "receipt", "note")
    people = it["face_count"] or 0
    if it["dup_group"] and it["dup_best"] == 0:
        if it["dup_kind"] == "exact":
            return "delete", "duplicate", "Exact copy of another file you have"
        if texty:
            return "unsure", "check", "Looks like another one in its group, but may be a different page"
        return "delete", "similar", "Look-alike shot, the sharpest one is kept"

    photo = it["kind"] == "photo"
    if photo and it["contrast"] is not None and it["contrast"] < 3 and (it["sharp"] or 0) < 15:
        return "delete", "blank", "Blank image, just one flat color"
    if not it["frames"]:
        return "unsure", "no_preview", "No preview could be made, check it yourself"
    if not typ or not it["faces_done"] or (texty and photo and not it["ocr_done"]):
        return None, None, None  # still being worked on

    text = it["ocr_text"] or ""
    if texty and (it["type_score"] or 0) < 0.5 and len(text.strip()) < 10:
        typ = "photo"  # a weak "screenshot/document" guess with no text in it: judge it as a photo
    keep_w, maybe_w, junk_w = _match(KEEP_WORDS, text), _match(MAYBE_WORDS, text), _match(JUNK_WORDS, text)
    ai = it["ai_verdict"]
    who = f"{people} {'person' if people == 1 else 'people'}" if people else ""
    if it["g_people"]:
        try:
            names = json.loads(it["g_people"])
            who = ", ".join(names[:3]) + (f" +{len(names) - 3}" if len(names) > 3 else "")
        except ValueError:
            pass

    if keep_w:
        return "keep", "important", f"{TYPE_LABEL.get(typ, 'Photo')} mentions \"{keep_w}\", looks important"
    if typ in ("document", "id_card"):
        if (it["type_score"] or 0) >= 0.5:
            return "keep", "important", "Looks like an important document"
        if not junk_w:
            return "unsure", "check", "Might be a document, check it"
        typ = "screenshot"  # a weak document guess with throwaway text: judge it like a screenshot

    if typ == "screenshot" and not photo:
        return "unsure", "check", "Looks like a screen recording"
    if typ == "screenshot":
        if maybe_w:
            return "unsure", "ticket", f"Screenshot mentions \"{maybe_w}\", check if you still need it"
        if known:
            return "unsure", "check", "Screenshot with someone you know in it"
        return "delete", "screenshot", f"Screenshot ({junk_w})" if junk_w else "Old screenshot"
    if typ in ("meme", "greeting"):
        if known:
            return "unsure", "check", f"Looks like a {typ}, but someone you know is in it"
        return "delete", "meme", "Forwarded greeting image" if typ == "greeting" else "Forwarded meme or picture"
    if typ == "receipt":
        if maybe_w:
            return "unsure", "ticket", f"Receipt mentions \"{maybe_w}\", check if you still need it"
        return "delete", "receipt", "Old receipt or bill"
    if typ == "note":
        return "unsure", "note", "Handwritten note or whiteboard, check if you still need it"

    # problems need the pixels to agree with SigLIP, so a moody photo or soft portrait isn't called junk
    bad = []
    if "accidental" in tags:
        bad.append("accidental")
    if "blurry" in tags and (it["sharp"] or 0) < 100:
        bad.append("blurry")
    bright = 255 if it["bright"] is None else it["bright"]
    contrast = 255 if it["contrast"] is None else it["contrast"]
    if photo and (("dark" in tags and bright < 60) or (bright < 18 and contrast < 20)):
        bad.append("dark")
    short = not photo and (it["duration"] or 0) < 1.5
    if bad or short:
        why = {"accidental": "Looks like an accidental shot", "blurry": "Very blurry", "dark": "Too dark to see anything"}
        reason = why[bad[0]] if bad else "Very short clip, maybe recorded by accident"
        if people or known:
            return "unsure", "poor_people", f"{reason}, but has {who or 'people'}"
        if ai == "keep":
            return "keep", "photo", f"{reason}, but the AI thinks it's worth keeping: {it['ai_reason'] or ''}".strip(": ")
        if ai == "delete" or bad and bad[0] in ("accidental", "dark"):
            return "delete", "poor", reason
        return "unsure", "poor", reason

    bits = [EVENT_LABEL.get(it["event"], (it["event"] or "").replace("_", " ").capitalize()) if it["event"]
            else TYPE_LABEL.get(typ, "Photo")]
    if who:
        bits.append(who)
    return "keep", it["event"] or ("people" if people else typ), " · ".join(bits)


COLS = ("id, status, kind, alias_of, dup_group, dup_kind, dup_best, contrast, sharp, bright, frames, duration, type, "
        "type_score, event, favorite, origin, g_people, user_decision, "
        "face_count, faces_done, ocr_done, ocr_text, ai_verdict, ai_reason")


def refresh(ids=None):
    if ids is None:
        items = db.rows(f"SELECT {COLS} FROM items")
        tag_rows = db.rows("SELECT item_id, tag FROM item_tags")
        known_rows = db.rows("""SELECT DISTINCT f.item_id FROM faces f JOIN persons p ON p.id=f.person_id
                                WHERE p.hidden=0 AND (p.items >= 3 OR p.name IS NOT NULL)""")
    else:
        ids = list(ids)
        q = ",".join("?" * len(ids))
        items = db.rows(f"SELECT {COLS} FROM items WHERE id IN ({q})", ids)
        tag_rows = db.rows(f"SELECT item_id, tag FROM item_tags WHERE item_id IN ({q})", ids)
        known_rows = db.rows(f"""SELECT DISTINCT f.item_id FROM faces f JOIN persons p ON p.id=f.person_id
                                 WHERE p.hidden=0 AND (p.items >= 3 OR p.name IS NOT NULL) AND f.item_id IN ({q})""", ids)
    tags = {}
    for r in tag_rows:
        tags.setdefault(r["item_id"], set()).add(r["tag"])
    known = {r["item_id"] for r in known_rows}
    now = time.time()
    out = []
    for it in items:
        d = decide(it, tags.get(it["id"], set()), it["id"] in known)
        out.append((*d, now if d[0] else None, it["id"]))
    db.write_many("UPDATE items SET decision=?, bucket=?, reason=?, decided_at=COALESCE(decided_at, ?) WHERE id=?", out)
