"""Paths and settings. Every one of these can be changed with an environment variable."""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _path(env, default):
    return os.path.abspath(os.environ.get(env, default))


# Where results, previews and face crops are kept
DATA = _path("CLEANER_DATA", os.path.join(ROOT, "data"))
THUMBS = os.path.join(DATA, "thumbs")      # 256px squares for the grid
PREVIEWS = os.path.join(DATA, "previews")  # 1024px copies the models look at
FACES = os.path.join(DATA, "faces")        # 160px face crops for the People tab
DB_PATH = os.path.join(DATA, "cleaner.db")
WEB = os.path.join(ROOT, "web")

# The photos folder used until one is picked in the dashboard
DEFAULT_INPUT = _path("CLEANER_INPUT", os.path.join(ROOT, "input"))
# Folders the dashboard's folder picker may show. Empty = the whole computer (fine when running locally);
# the Docker image sets this to /photos, the folder you share with the container.
BROWSE_ROOTS = [os.path.abspath(p) for p in os.environ.get("CLEANER_BROWSE_ROOTS", "").split(os.pathsep) if p]

# Downloaded models
MODELS = _path("CLEANER_MODELS", os.path.join(ROOT, "models"))
os.environ.setdefault("HF_HOME", os.path.join(MODELS, "hf-cache"))
SIGLIP_REPO = os.environ.get("CLEANER_SIGLIP", "google/siglip2-so400m-patch14-384")
SIGLIP_DIR = os.path.join(MODELS, "siglip2")
FACE_DIR = os.path.join(MODELS, "buffalo_l")
FACE_URL = "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip"

# Web server. 127.0.0.1 keeps it private to this computer; Docker sets 0.0.0.0 inside the container
# and publishes the port on the host's 127.0.0.1 only.
HOST = os.environ.get("CLEANER_HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", 8770))

# Videos this long or longer are skipped for now. Pixel motion-photo clips are 0.6-2.9 s.
VIDEO_MAX_S = float(os.environ.get("CLEANER_VIDEO_MAX_S", 5))

PREVIEW_SIZE = 1024
THUMB_SIZE = 256
SCAN_THREADS = 6

IMG = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".dng"}
VID = {".mp4", ".mov", ".m4v", ".3gp", ".avi", ".mkv", ".webm", ".mts", ".mp"}

# Look-alike photos: perceptual hash distance (0-64) and how close in time they must be
SIMILAR_DISTANCE = 6
SIMILAR_WINDOW_S = 10 * 60

# Faces: same person when cosine similarity of ArcFace fingerprints is at least this
FACE_MATCH = float(os.environ.get("CLEANER_FACE_MATCH", 0.5))
FACE_MIN_PX = 36        # smaller faces count as "has people" but aren't grouped
PERSON_MIN_FACES = 3    # a group needs this many faces to become a person

for d in (DATA, THUMBS, PREVIEWS, FACES, MODELS):
    os.makedirs(d, exist_ok=True)
