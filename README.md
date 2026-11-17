# Photo Cleaner

Free up Google Photos storage without uploading your photos anywhere. Photo Cleaner reads a Google Takeout export on your own computer and uses open AI models to find what you can delete: old screenshots and OTP messages, forwarded memes, receipts, blurry and accidental shots, exact copies and burst shots. It groups people by face the way Google Photos does, tags every photo, and puts them on a map. You review everything in a web dashboard, and nothing is deleted until you say so.

Runs on Windows, macOS and Linux, with Docker or without. An NVIDIA graphics card makes it faster but isn't required.

## What you get

- A Suggested delete list, grouped by reason (screenshots, exact copies, look-alike shots, memes, receipts, blurry or dark), with the better copy shown next to each duplicate.
- Tags on every photo: its type (photo, screenshot, document, ID card, receipt, note, meme, greeting, artwork), the occasion (wedding, birthday, Diwali, Holi, Eid, Christmas, a trip and so on) and what's in it (food, beach, kids, pets and more).
- A People tab: faces grouped into people, named automatically from your Google Photos face tags where possible. Name, merge or hide people, and select all of someone's photos.
- A Map of every photo with a location, with a heat map and drag-to-select.
- Search in plain words, like "birthday cake" or "whatsapp forward", plus filters for type, event, tag, year and person.
- Safety rules that lean toward keeping: documents, favorites, photos of people you know, and anything mentioning a passport or certificate are never suggested for deletion.
- An optional browser extension that moves your approved photos to the Google Photos trash for you, one by one, in your own logged-in browser.

## How it works

Everything runs on your computer, one step at a time:

| Step | What happens | Model |
|---|---|---|
| Scan | Reads each file once, makes small previews, reads Google's info file for each photo (date, location, people, link) | |
| Duplicates | Finds exact copies and look-alike shots, keeps the sharpest | |
| Tags | Gives each photo a type, an event and scene tags; also powers search | SigLIP 2 (Google) |
| Faces | Finds every face and makes a fingerprint of it | InsightFace (SCRFD + ArcFace) |
| People | Groups matching faces into people | |
| Read text | Reads screenshots, documents and receipts (OTP codes, tickets, certificates) | RapidOCR |
| Suggestions | Turns all of the above into keep, delete or unsure | rules in `cleaner/rules.py` |
| Second opinion (optional) | Takes another look at photos that seem blurry or accidental | Qwen2.5-VL through Ollama |

Photo Cleaner never deletes or changes your photos. It reads your Takeout folder and writes its results to its own data folder.

Long videos (5 seconds or more) are skipped for now. Short clips, including the motion part of Pixel and iPhone live photos, are judged by their middle frame.

## Before you start: export your photos

1. Go to [takeout.google.com](https://takeout.google.com), click "Deselect all", tick only Google Photos, and create the export.
2. Download all the zip files and unzip them into one folder.

Album folders in the export are fine: the tool recognises album copies as the same photo.

## Quick start with Docker (recommended)

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows, macOS) or Docker Engine (Linux), and about 10 GB of free disk space.

1. Download or clone this repository and open a terminal in its folder.
2. Copy `.env.example` to `.env` and set `PHOTOS` to your unzipped Takeout folder:
   ```
   PHOTOS=C:/Users/you/Downloads/Takeout
   ```
   On macOS that looks like `PHOTOS=/Users/you/Downloads/Takeout`. Docker shares only this folder with the app, read-only.
3. Start it:
   ```
   docker compose up
   ```
   The first start builds the image and downloads the models (about 5 GB), so give it a while. Later starts take seconds.
4. Open http://127.0.0.1:8770 and press Start.

To add the optional AI second opinion (Qwen2.5-VL, about 6 GB more), start with `docker compose --profile ai up` instead.

With an NVIDIA graphics card (Windows with WSL 2, or Linux with the NVIDIA Container Toolkit installed), tagging runs much faster:

```
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up
```

On a Mac, Docker can't use the Mac's graphics chip, so it runs on the processor. That works, just slower. For full speed on Apple Silicon, run it without Docker as described next.

## Running without Docker

You need Python 3.10 or newer. ffmpeg (for short videos) and [Ollama](https://ollama.com) (for the second opinion) are optional.

On Windows:

```
.\setup.ps1
.\start.ps1
```

After setup you can also double-click `Start Photo Cleaner.bat`.

On macOS or Linux:

```
./setup.sh
./start.sh
```

Setup installs the Python packages and downloads the models into `models/`. If a download fails, run it again: it skips what's already there. The dashboard opens at http://127.0.0.1:8770. Pick your Takeout folder with "Choose folder" (or in Settings) and press Start.

It uses CUDA on an NVIDIA card, the graphics chip on Apple Silicon, and the processor otherwise.

## Using the dashboard

- Suggested delete: go through one reason at a time with the chips at the top. Click photos to select them, then Approve for delete or Keep. Double-click a photo to see it full size and use the keyboard: K to keep, D to approve for delete, B to approve both a duplicate and its kept copy, arrow keys to move.
- Unsure: tickets, notes, blurry photos with people in them, and other things the tool won't decide alone.
- Duplicates: each group side by side, with the copy it suggests keeping marked in green.
- People: click a person to see their photos. Rename, merge two groups of the same person, or hide strangers. Photos of people you know are protected.
- Map: hold Shift and drag (or press "Select an area") to pick an area. The photos inside appear below, and "Open this area in a new tab" opens them as a filter.
- Approved for delete: your delete list. Each photo links to itself in Google Photos. Delete it there and tick it, or let the extension do it. Deleted photos move to the Deleted in Google tab.
- Settings (the gear icon): the photos folder, the second opinion, and Start over, which clears all results so you can run again.

Your storage only comes back after you empty the trash in Google Photos.

## Deleting in Google Photos with one click (optional)

Google doesn't let apps delete photos through an API, so the `extension` folder holds a small Chrome and Edge extension that does it the way you would. It opens each approved photo in a small window, in the browser where you're signed in to Google, presses delete and confirms. It never sees your password and only touches photos on your Approved for delete list.

1. Open `chrome://extensions` (or `edge://extensions`), turn on Developer mode, click Load unpacked and pick the `extension` folder.
2. Open the dashboard in that same browser and go to Approved for delete.
3. Run it once with "Test only" ticked. It checks that it can find each photo's delete button, without deleting anything.
4. Untick "Test only", pick a speed, and start. Keep the small Google Photos window visible while it works.

It stops on its own when something looks unexpected. It depends on how the Google Photos website looks, so a redesign can break it until it's updated. Automated clicking is a grey area under Google's terms; the default speed is roughly a person's pace. Anything moved to the trash can be restored there for 30 days.

## Privacy

- The dashboard only listens on your own computer (127.0.0.1). The Docker setup publishes it the same way.
- Your photos are only read. Previews, face crops and results stay in the data folder (`data/`, or the `photo-cleaner-data` Docker volume).
- The models run locally. Nothing about your photos is sent anywhere.
- The map background is loaded from OpenStreetMap, which sees which areas of the map you view, but not your photos or their locations.

## Models and licenses

The code is MIT licensed. Setup downloads the models from their official sources, and each keeps its own license:

| Model | License |
|---|---|
| SigLIP 2 so400m (Google) | Apache 2.0 |
| InsightFace buffalo_l | Non-commercial research use only |
| RapidOCR / PaddleOCR models | Apache 2.0 |
| Qwen2.5-VL 7B (optional) | Apache 2.0 |

Sorting your own photos counts as non-commercial use. If you build a commercial product on this code, replace the InsightFace models. Full details, including the bundled map libraries, are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Configuration

Everything has a default. These environment variables change it:

| Variable | Default | What it does |
|---|---|---|
| `CLEANER_INPUT` | `input/` | Photos folder used until you pick one in the dashboard |
| `CLEANER_DATA` | `data/` | Where results, previews and face crops are kept |
| `CLEANER_MODELS` | `models/` | Where models are downloaded |
| `CLEANER_BROWSE_ROOTS` | the whole computer | Limits the folder picker to these folders (Docker sets `/photos`) |
| `PORT` | `8770` | Dashboard port |
| `CLEANER_HOST` | `127.0.0.1` | Address the server listens on (Docker sets `0.0.0.0` inside the container) |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Where Ollama runs |
| `CLEANER_MODEL` | `qwen2.5vl:7b` | Ollama model for the second opinion |
| `CLEANER_VIDEO_MAX_S` | `5` | Videos this long or longer are skipped |
| `CLEANER_FACE_MATCH` | `0.5` | How alike two faces must be to count as one person; raise it if different people get merged |
| `CLEANER_SIGLIP` | `google/siglip2-so400m-patch14-384` | Tagging model on Hugging Face |

The tag list lives in `cleaner/taglist.py`. Change or add tags there and press "Check for new files". Tags are worked out from fingerprints saved during the first run, so a change takes seconds rather than a full re-run.

## Project layout

```
app.py                  starts the dashboard
cleaner/
  scan.py               finds files, makes previews, reads Google's info files
  dupes.py              exact copies, look-alikes, album copies and live photos
  tagger.py, taglist.py SigLIP 2 tags and search
  faces.py, people.py   face detection, fingerprints, grouping into people
  ocr.py                text in screenshots and documents
  rules.py              keep / delete / unsure
  llm.py                optional Qwen second opinion
  pipeline.py           runs the steps in order, with pause and resume
  server.py             the dashboard's web server and API
  download.py           model downloads
web/                    the dashboard (plain HTML, CSS and JavaScript, no build step)
extension/              the optional browser extension for deleting in Google Photos
docker/, Dockerfile, docker-compose*.yml
```

## Contributing

Issues and pull requests are welcome. Good places to start:

- Better tag phrasings for your language or culture in `cleaner/taglist.py`.
- Safer or smarter rules in `cleaner/rules.py`.
- The extension's Google Photos selectors, when Google changes its website.

Please keep the project's two promises: it never changes anyone's photos, and nothing about them leaves their computer.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
