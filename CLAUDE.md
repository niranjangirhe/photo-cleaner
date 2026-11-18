# Photo Cleaner: notes for coding agents

Photo Cleaner tags a Google Takeout export with local open models, groups faces into people, and suggests what to delete. The dashboard is at http://127.0.0.1:8770. See README.md for what users see.

## Promises (never break these)

1. Never move, rename or delete anything in the user's photos folder. The tool only reads it.
2. Nothing about the photos leaves the computer. No telemetry, no cloud APIs.
3. Never commit `input/`, `data/`, `models/`, `.env` or `Demo/`.

## Pipeline (cleaner/pipeline.py, one model on the GPU at a time)

scan -> dupes -> tagger (SigLIP 2, GPU/MPS/CPU) -> faces (SCRFD + ArcFace via onnxruntime, CPU) -> people (mutual-kNN grouping) -> ocr (RapidOCR, CPU, texty types only) -> rules.

- `textrules.py`: plain word lists (important, receipt, receipt_keep, check, throwaway) that `rules.py` applies to the OCR text. Entries starting with "re:" are regular expressions.

- Per-photo background loading goes through `pool.prefetch()`, never `ThreadPoolExecutor.map()` over the whole library: map queues every item at once, and in the faces step that held every decoded preview in memory until the app was killed (29k photos, ~15 GB).
- The photos folder is a setting (`db.input_dir()`), picked in the dashboard. Switching folders clears the old results.
- `taglist.py`: phrasings are averaged per tag. Types and events use softmax; scenes use softmax against a plain "a photo." background. SigLIP's sigmoid probabilities are tiny for these prompts, so don't threshold on them.
- Image fingerprints are stored in `items.emb` (float16). `tagger.apply_tags()` re-tags from them without the model if `data/label_cache.npz` matches the current taglist.
- `faces.py` runs the buffalo_l ONNX files directly (the `insightface` package needs C++ build tools on Windows).
- `people.py` keeps typed names across re-grouping by majority vote; `auto_name()` names groups from Google's own people tags.
- `data/cleaner.db`: `decision` is the tool's suggestion, `user_decision` is the person's choice and always wins. Bulk actions never override a per-photo choice.

## Running and checking

- Native: `.\setup.ps1` / `./setup.sh`, then `.\start.ps1` / `./start.sh`.
- Docker: `docker compose up` (CPU) or `docker compose -f nvidia.yml up` (NVIDIA). Keep the two files in step.
- Test against a separate library and data folder so a real one is never touched: set `CLEANER_INPUT`, `CLEANER_DATA` and `PORT`.
- `python -m pyflakes app.py cleaner` should be clean; `node --check web/app.js extension/background.js`.
