"""Downloads the models into the models folder. Safe to run again: it skips what's already there.

  python -m cleaner.download

- SigLIP 2 (Google, Hugging Face)          tags every photo, powers search     ~4.5 GB
- InsightFace buffalo_l (GitHub release)   finds faces, face fingerprints      ~0.3 GB
- RapidOCR reads text; its small models come inside the pip package.

Progress is printed as plain lines every few seconds ("1.2 of 4.5 GB, 12 MB/s, about 5 min left"),
which also shows up in Docker's log view, where animated progress bars freeze.
Setting HF_TOKEN (a free Hugging Face account token) is optional and only makes the SigLIP download faster.
"""
import importlib.util
import os
import shutil
import sys
import threading
import time
import urllib.request
import zipfile

from .config import FACE_DIR, FACE_URL, MODELS, SIGLIP_DIR, SIGLIP_REPO

# Hugging Face's own animated bars don't work in Docker's log view; our progress lines replace them
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
# The newer "Xet" transfer only writes the model to disk at the very end, so there is nothing to measure
# (and nothing to resume) until it's done. The standard download writes as it goes.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
SIGLIP_FILES = ["*.json", "*.safetensors", "*.model", "*.txt"]
EVERY_S = 5


def siglip_ready():
    return os.path.exists(os.path.join(SIGLIP_DIR, "config.json")) and any(
        f.endswith(".safetensors") for f in os.listdir(SIGLIP_DIR))


def faces_ready():
    return all(os.path.exists(os.path.join(FACE_DIR, f)) for f in ("det_10g.onnx", "w600k_r50.onnx"))


def _size(n):
    return f"{n / 1e9:.1f} GB" if n >= 1e9 else f"{n / 1e6:.0f} MB"


class Progress:
    """Prints 'name: 1.2 of 4.5 GB (27%), 12 MB/s, about 5 min left' every few seconds."""

    def __init__(self, name, total, already=0):
        self.name, self.total, self.already = name, total, already  # already: bytes from a stopped earlier try
        self.t0 = self.last = time.time()

    def show(self, done, final=False):
        now = time.time()
        if not final and now - self.last < EVERY_S:
            return
        self.last = now
        speed = (done - self.already) / max(now - self.t0, 0.001)
        parts = [f"{_size(done)} of {_size(self.total)} ({100 * done // self.total}%)" if self.total else f"{_size(done)} so far"]
        if speed > 0 and not final:
            parts.append(f"{speed / 1e6:.1f} MB/s")
            if self.total and done < self.total:
                left = (self.total - done) / speed
                parts.append(f"about {int(left // 60)} min {int(left % 60)} s left" if left >= 60 else f"about {int(left)} s left")
        print(f"  {self.name}: {', '.join(parts)}", flush=True)


def _folder_bytes(path):
    """Bytes on disk under a folder, including Hugging Face's half-finished download files."""
    total = 0
    for dp, _, fs in os.walk(path):
        for f in fs:
            try:
                total += os.path.getsize(os.path.join(dp, f))
            except OSError:
                pass
    return total


def get_siglip():
    if siglip_ready():
        print("SigLIP 2: already downloaded")
        return
    from fnmatch import fnmatch

    from huggingface_hub import HfApi, snapshot_download
    from huggingface_hub.utils import logging as hf_logging
    hf_logging.set_verbosity_error()  # no "unauthenticated requests" warning: downloading without an account is fine
    total = 0
    try:
        info = HfApi().model_info(SIGLIP_REPO, files_metadata=True)
        total = sum(s.size or 0 for s in info.siblings if any(fnmatch(s.rfilename, p) for p in SIGLIP_FILES))
    except Exception:
        pass  # sizes are only for the progress lines
    print(f"SigLIP 2: downloading {SIGLIP_REPO} ({_size(total) if total else 'about 4.5 GB'}). "
          "This is the big one; later starts skip it.", flush=True)
    os.makedirs(SIGLIP_DIR, exist_ok=True)
    # a download that was stopped earlier picks up where it left off
    progress = Progress("SigLIP 2", total, already=_folder_bytes(SIGLIP_DIR))
    finished = threading.Event()

    def watch():
        while not finished.wait(1):
            progress.show(_folder_bytes(SIGLIP_DIR))

    threading.Thread(target=watch, daemon=True).start()
    try:
        snapshot_download(SIGLIP_REPO, local_dir=SIGLIP_DIR, allow_patterns=SIGLIP_FILES)
    finally:
        finished.set()
    shutil.rmtree(os.path.join(SIGLIP_DIR, ".cache"), ignore_errors=True)  # Hugging Face's bookkeeping
    print("SigLIP 2: done", flush=True)


def get_faces():
    if faces_ready():
        print("Face models: already downloaded")
        return
    os.makedirs(FACE_DIR, exist_ok=True)
    tmp = os.path.join(MODELS, "buffalo_l.zip")
    print("Face models: downloading InsightFace buffalo_l (about 280 MB)...", flush=True)
    progress = None

    def hook(blocks, block_size, total):
        nonlocal progress
        if progress is None:
            progress = Progress("Face models", max(total, 0))
        progress.show(min(blocks * block_size, total) if total > 0 else blocks * block_size)

    urllib.request.urlretrieve(FACE_URL, tmp, hook)
    with zipfile.ZipFile(tmp) as z:
        for name in z.namelist():
            base = os.path.basename(name)
            if base in ("det_10g.onnx", "w600k_r50.onnx"):
                with z.open(name) as src, open(os.path.join(FACE_DIR, base), "wb") as dst:
                    shutil.copyfileobj(src, dst)
    os.remove(tmp)
    print("Face models: done", flush=True)


def status():
    ocr = importlib.util.find_spec("rapidocr_onnxruntime") is not None  # its models ship inside the package
    return {"siglip": siglip_ready(), "faces": faces_ready(), "ocr": ocr}


if __name__ == "__main__":
    ok = True
    for step in (get_siglip, get_faces):
        try:
            step()
        except Exception as e:
            ok = False
            print(f"FAILED: {e}")
    sys.exit(0 if ok else 1)
