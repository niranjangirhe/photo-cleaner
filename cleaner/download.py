"""Downloads the models into the models folder. Safe to run again: it skips what's already there.

  python -m cleaner.download            SigLIP 2 and the face models
  python -m cleaner.download --ollama   also Qwen2.5-VL through Ollama (optional second opinion)

- SigLIP 2 (Google, Hugging Face)          tags every photo, powers search     ~4.5 GB
- InsightFace buffalo_l (GitHub release)   finds faces, face fingerprints      ~0.3 GB
- RapidOCR reads text; its small models come inside the pip package.
- Qwen2.5-VL 7B through Ollama (optional)                                      ~6 GB
"""
import importlib.util
import os
import shutil
import sys
import time
import urllib.request
import zipfile

from .config import DEFAULT_MODEL, FACE_DIR, FACE_URL, MODELS, SIGLIP_DIR, SIGLIP_REPO


def siglip_ready():
    return os.path.exists(os.path.join(SIGLIP_DIR, "config.json")) and any(
        f.endswith(".safetensors") for f in os.listdir(SIGLIP_DIR))


def faces_ready():
    return all(os.path.exists(os.path.join(FACE_DIR, f)) for f in ("det_10g.onnx", "w600k_r50.onnx"))


def get_siglip():
    if siglip_ready():
        print("SigLIP 2: already downloaded")
        return
    from huggingface_hub import snapshot_download
    print(f"SigLIP 2: downloading {SIGLIP_REPO} (about 4.5 GB)...", flush=True)
    snapshot_download(SIGLIP_REPO, local_dir=SIGLIP_DIR,
                      allow_patterns=["*.json", "*.safetensors", "*.model", "*.txt"])
    print("SigLIP 2: done")


def get_faces():
    if faces_ready():
        print("Face models: already downloaded")
        return
    os.makedirs(FACE_DIR, exist_ok=True)
    tmp = os.path.join(MODELS, "buffalo_l.zip")
    print("Face models: downloading InsightFace buffalo_l (about 280 MB)...", flush=True)

    def hook(n, size, total):
        if total > 0 and n % 400 == 0:
            print(f"  {min(100, n * size * 100 // total)}%", flush=True)

    urllib.request.urlretrieve(FACE_URL, tmp, hook)
    with zipfile.ZipFile(tmp) as z:
        for name in z.namelist():
            base = os.path.basename(name)
            if base in ("det_10g.onnx", "w600k_r50.onnx"):
                with z.open(name) as src, open(os.path.join(FACE_DIR, base), "wb") as dst:
                    shutil.copyfileobj(src, dst)
    os.remove(tmp)
    print("Face models: done")


def get_ollama_model():
    from . import llm
    wait = int(os.environ.get("CLEANER_OLLAMA_WAIT", 0))  # seconds to wait for an Ollama container to start
    for tries_left in range(max(1, wait // 5), 0, -1):
        try:
            names = llm.models()
            break
        except llm.OllamaError as e:
            if tries_left == 1:
                print(f"Ollama isn't running, so the optional second opinion is skipped ({e})")
                return
            time.sleep(5)
    if llm.has(DEFAULT_MODEL, names):
        print(f"Ollama {DEFAULT_MODEL}: already downloaded")
        return
    print(f"Ollama {DEFAULT_MODEL}: downloading (about 6 GB)...", flush=True)
    llm.pull(DEFAULT_MODEL, lambda s: print(s, flush=True))
    print(f"Ollama {DEFAULT_MODEL}: done")


def status():
    ocr = importlib.util.find_spec("rapidocr_onnxruntime") is not None  # its models ship inside the package
    return {"siglip": siglip_ready(), "faces": faces_ready(), "ocr": ocr}


if __name__ == "__main__":
    steps = [get_siglip, get_faces] + ([get_ollama_model] if "--ollama" in sys.argv else [])
    ok = True
    for step in steps:
        try:
            step()
        except Exception as e:
            ok = False
            print(f"FAILED: {e}")
    sys.exit(0 if ok else 1)
