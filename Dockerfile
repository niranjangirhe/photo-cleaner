# Photo Cleaner. Works on Windows, macOS (Intel and Apple Silicon) and Linux.
#
#   docker compose up                     processor only, runs everywhere
#   docker compose -f nvidia.yml up       NVIDIA graphics card
#
# The models are not baked into the image: they are downloaded on first start into the "models" volume.

FROM python:3.11-slim

# PyTorch build: the CPU one by default; the GPU compose file passes the CUDA one instead.
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    CLEANER_HOST=0.0.0.0 \
    CLEANER_DATA=/data \
    CLEANER_MODELS=/models \
    CLEANER_INPUT=/photos \
    CLEANER_BROWSE_ROOTS=/photos

# ffmpeg for short videos; libgl/glib for OpenCV
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install torch --index-url "$TORCH_INDEX" \
 && pip install -r requirements.txt

COPY app.py ./
COPY cleaner ./cleaner
COPY web ./web
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /photos /data /models

EXPOSE 8770
VOLUME ["/data", "/models"]
ENTRYPOINT ["/entrypoint.sh"]
