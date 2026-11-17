"""Optional last step: a local vision model (Qwen2.5-VL through Ollama) gives a second opinion on
photos the other steps found unclear (blurry, dark or accidental-looking, with no people in them)."""
import base64
import json
import os
import re
import time
import urllib.error
import urllib.request

from .config import OLLAMA_URL, PREVIEWS

SCHEMA = {
    "type": "object",
    "properties": {
        "description": {"type": "string"},
        "verdict": {"type": "string", "enum": ["keep", "delete", "unsure"]},
        "reason": {"type": "string"},
    },
    "required": ["description", "verdict", "reason"],
}

SYSTEM = """You help someone free up space in their photo library. Another tool flagged this photo as possibly
blurry, too dark, or taken by accident, and asks for your second opinion. You see the photo (or frames from a
short video) plus some facts about the file.

Deleting a real memory is much worse than keeping a bit of junk. When you are not sure, answer "unsure".

Answer "delete" for: pocket or floor shots, the ceiling, a finger over the lens, photos so blurry or dark that
nothing can be made out, no clear subject at all.
Answer "keep" if there is anything worth remembering: people, pets, a place, an event, something personal,
even when the photo isn't perfect.

Answer in JSON:
- description: what is in it, at most 15 words
- verdict: keep, delete or unsure
- reason: why, at most 12 words, written for the owner (for example "Blurry pocket shot of the floor")"""


class OllamaError(Exception):
    pass


def _call(path, body=None, timeout=10):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(OLLAMA_URL + path, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors="replace")[:300]
        raise OllamaError(f"Ollama said {e.code}: {msg}") from e
    except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
        raise OllamaError(f"Can't reach Ollama at {OLLAMA_URL} ({getattr(e, 'reason', e)})") from e


def models():
    """Names of downloaded models, or raises OllamaError if Ollama isn't running."""
    return [m["name"] for m in _call("/api/tags").get("models", [])]


def has(name, names):
    return name in names or (":" not in name and name + ":latest" in names)


def pull(name, progress=print):
    """Download a model into Ollama (used by the Docker setup). Streams Ollama's progress lines."""
    req = urllib.request.Request(OLLAMA_URL + "/api/pull", data=json.dumps({"model": name}).encode(),
                                 headers={"Content-Type": "application/json"})
    last = ""
    with urllib.request.urlopen(req, timeout=3600) as r:
        for line in r:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("error"):
                raise OllamaError(msg["error"])
            status = msg.get("status", "")
            if msg.get("total"):
                status += f" {100 * msg.get('completed', 0) // msg['total']}%"
            if status != last:
                progress(f"  {status}")
                last = status


def facts(it):
    lines = [f"File name: {it['name']}"]
    if it["taken"]:
        lines.append("Taken: " + time.strftime("%Y-%m-%d %H:%M", time.localtime(it["taken"])))
    size = f"{(it['bytes'] or 0) / 1e6:.1f} MB"
    if it["w"] and it["h"]:
        size += f", {it['w']}x{it['h']} pixels"
    lines.append("Size: " + size)
    if it["kind"] == "video":
        lines.append(f"This is a short VIDEO, {it['duration'] or 0:.1f} seconds long; you see its middle frame.")
    if it.get("tags"):
        lines.append("Tags from the other tool: " + ", ".join(it["tags"]))
    return "\n".join(lines)


def image(it):
    p = os.path.join(PREVIEWS, f"{it['id']}.jpg")
    if not os.path.exists(p):
        return None
    with open(p, "rb") as f:
        return base64.b64encode(f.read()).decode()


def analyze(it, model):
    """Returns ({description, ai_verdict, ai_reason}, milliseconds)."""
    img = image(it)
    if not img:
        raise ValueError("no preview to show the model")
    body = {
        "model": model, "stream": False, "format": SCHEMA, "keep_alive": "10m",
        "options": {"temperature": 0, "num_ctx": 4096},
        "messages": [{"role": "system", "content": SYSTEM},
                     {"role": "user", "content": facts(it), "images": [img]}],
    }
    t0 = time.time()
    r = _call("/api/chat", body, timeout=600)
    text = (r.get("message") or {}).get("content", "")
    try:
        ans = json.loads(text)
    except ValueError:
        m = re.search(r"\{.*\}", text, re.S)
        if not m:
            raise ValueError(f"model gave no JSON: {text[:120]}")
        ans = json.loads(m.group(0))
    out = {
        "description": str(ans.get("description", ""))[:200],
        "ai_verdict": ans.get("verdict") if ans.get("verdict") in ("keep", "delete", "unsure") else "unsure",
        "ai_reason": str(ans.get("reason", ""))[:200],
    }
    return out, int((time.time() - t0) * 1000)
