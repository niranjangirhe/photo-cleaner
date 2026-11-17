# Third-party notices

Photo Cleaner's own code is under the MIT license (see `LICENSE`). It builds on the open models and libraries below. None of the models are included in this repository: setup downloads each one from its official source, under its own license.

## Models

| Model | Used for | Source | License |
|---|---|---|---|
| SigLIP 2 so400m-patch14-384 (Google) | Tags, search | Hugging Face: `google/siglip2-so400m-patch14-384` | Apache 2.0 |
| InsightFace buffalo_l (SCRFD detector + ArcFace recognition) | Finding faces, grouping people | InsightFace GitHub release v0.7 | Non-commercial research use only |
| RapidOCR (PaddleOCR PP-OCR models) | Reading text | `rapidocr_onnxruntime` on PyPI | Apache 2.0 |
| Qwen2.5-VL 7B (optional) | Second opinion on unclear photos | Ollama library: `qwen2.5vl:7b` | Apache 2.0 |

The InsightFace models are free for non-commercial use, which covers sorting your own photos. If you build a commercial product on this code, swap them for commercially licensed face models.

## Bundled in this repository

The map in the dashboard uses Leaflet 1.9.4 (BSD 2-Clause), Leaflet.markercluster 1.5.3 (MIT) and Leaflet.heat 0.2.0 (BSD 2-Clause). They are in `web/vendor/`, and their license texts are in `web/vendor/LICENSES.md`. Map tiles come from OpenStreetMap (© OpenStreetMap contributors, ODbL) and are loaded from openstreetmap.org when the map is shown.

## Python packages (installed by setup, not bundled)

| Package | License |
|---|---|
| PyTorch | BSD 3-Clause |
| transformers, huggingface_hub | Apache 2.0 |
| onnxruntime | MIT |
| opencv-python | Apache 2.0 (OpenCV), MIT (packaging) |
| rapidocr_onnxruntime | Apache 2.0 |
| Pillow | MIT-CMU (HPND) |
| pillow-heif | BSD 3-Clause (it links libheif, LGPL 3.0) |
| ImageHash | BSD 2-Clause |
| NumPy | BSD 3-Clause |
| sentencepiece | Apache 2.0 |
| protobuf | BSD 3-Clause |

ffmpeg (LGPL/GPL, depending on the build) is used as a separate program for short videos. It is installed by the Docker image or by you, never linked into this code.
