# Open-source the manga app as **GaLib** + split the finder into **GaLib-Finder**

## Context

`manga-library` (branded "manga-dl") is a private Flask app that both **downloads**
manga from Weeb Central and **reads** it (library, RTL reader, synced progress, PWA).
We want an open-source core — **GaLib** — that ships only the library/reader, with the
scrape/download half extracted into a separate, separately-maintained repo —
**GaLib-Finder** — pinned back into GaLib as an optional git submodule.

This mirrors exactly what was already done for the ebook app: `HonLib` (core) +
`HonLib-IRC` (optional acquisition plugin at `acquisition/irc/`). We follow that
established pattern. Both target repos already exist as fresh GitHub repos with just an
`Initial commit` + `LICENSE`:
- `GaLib` → https://github.com/east35/GaLib.git
- `GaLib-Finder` → https://github.com/east35/GaLib-Finder.git

Decisions confirmed with the user:
- **Keep the `MANGA_DL_*` env-var prefix** (like HonLib kept `EBOOK_LIB_*`); do not rename.
- **Move the Weeb Central URL check into GaLib-Finder** so the GaLib core is source-agnostic.

Source of truth for the code: `/Users/jimjordan/Development/03.Lib/manga-library`.
Reference implementation of the pattern: `/Users/jimjordan/Development/03.Lib/HonLib`
and `/Users/jimjordan/Development/03.Lib/HonLib-IRC`.

---

## Plugin contract (the seam)

GaLib loads an **optional** package mounted at `finder/` (submodule → GaLib-Finder),
mirroring HonLib's `acquisition/irc/` + `client` object contract
(`HonLib/app.py:22-39`, `HonLib/README.md` "Acquisition plugin"):

```python
# finder/__init__.py  (GaLib-Finder)
class _Client:
    def matches(self, url: str) -> bool: ...        # owns the weebcentral.com/series/ check
    def download_series(self, url, output, *, chapters=None, log=print, stop=None) -> Path: ...

client = _Client()
```

GaLib guards the import and validates the contract, exactly like `_valid_irc_plugin`:

```python
try:
    from finder import client as _finder
except ImportError:
    _finder = None
FINDER_METHODS = ("matches", "download_series")
HAS_FINDER = _finder is not None and all(callable(getattr(_finder, m, None)) for m in FINDER_METHODS)
finder = _finder if HAS_FINDER else None
```

When absent: download endpoints return 503, `/api/features` reports it, the UI hides the
download affordances — the reader/library stay fully usable.

---

## Phase A — build & push GaLib-Finder

Repo dir: `/Users/jimjordan/Development/03.Lib/GaLib-Finder` (currently only `LICENSE`).

1. Turn the current `manga-library/manga_core.py` into the package body. Keep all
   existing functions (`parse_series_url`, `fetch_series_meta`, `fetch_chapters`,
   `download_chapter`, `download_series`, etc.) — they are already parameterized with
   `log=` / `stop=` and return the series `Path`, so no logic rewrite is needed.
   - Put the scraper in `finder/weebcentral.py` (verbatim move of `manga_core.py`).
   - `finder/__init__.py`: define `_Client` wrapping it —
     `matches(url)` = the check currently hardcoded in `app.py:497`
     (`"weebcentral.com" in url and "/series/" in url`); `download_series(...)` delegates
     to `weebcentral.download_series(...)`. Export `client = _Client()`.

   NOTE: GaLib-Finder is a package that gets mounted **as** `finder/` inside GaLib.
   Its repo root is the package (like HonLib-IRC: `__init__.py` at repo root). So the
   repo contains `__init__.py`, `weebcentral.py`, etc. at top level.

2. Add supporting files (mirror `HonLib-IRC/`):
   - `README.md` — what it is, the `client` contract, that it's mounted at `finder/` in GaLib.
   - `requirements.txt` — `requests>=2.31`, `beautifulsoup4>=4.12` (the finder-only deps).
   - `.gitignore` — `__pycache__/`, `*.pyc`, `.DS_Store`, `.claude/`.
   - `tests/` — a small smoke test (`parse_series_url`, `parse_range`, `chapter_parts`,
     `matches`) so the repo has CI-able tests like HonLib-IRC does.

3. Commit and **push** (`origin main`).

---

## Phase B — build & push GaLib (core)

Repo dir: `/Users/jimjordan/Development/03.Lib/GaLib` (currently only `LICENSE`).

Copy the core from `manga-library`, **excluding `manga_core.py`** (now in the finder), then:

### app.py (`manga-library/app.py` → GaLib)
- Replace `import manga_core` (line 31) with the guarded finder import + `HAS_FINDER`
  block above.
- `run_download` (`:300`): call `finder.download_series(...)` instead of
  `manga_core.download_series(...)`.
- `start_download` (`:490`): early-return 503 when `not HAS_FINDER`; replace the
  hardcoded weebcentral check (`:497`) with `if not finder.matches(url): return 400`.
- Add `@app.route("/api/features")` → `jsonify({"finder": HAS_FINDER})` (mirror
  `HonLib/app.py:596`).
- Rebrand strings: `LOGIN_HTML` title/`<h1>` "manga-dl" → "GaLib" (`:117,138`), the
  `print(...)` startup banner (`:828`). **Keep every `MANGA_DL_*` env var name.**

### Frontend (`static/index.html`, `static/app.js`)
- On load, fetch `/api/features`; when `finder` is false, hide `#open-download`
  (`index.html:69`), the download modal (`#download-modal`), and the "Find manga →"
  external link (`index.html:66-68`). Mirror how HonLib hides its Add UI.
- Adjust the empty-library copy (`app.js:353`, "Tap 'Download manga' to start") to a
  neutral message when the finder is absent.
- Rebrand visible "manga-dl" wordmark → "GaLib".

### Dependencies / build
- `requirements.txt` (core only): `flask>=3.0`, `pillow>=10.0`. (requests + bs4 now live
  in the finder and are only imported when the plugin is present.)
- `Dockerfile`: drop `COPY app.py manga_core.py` → `COPY app.py`; `COPY static ./static`;
  add `COPY finder ./finder` (present only when the submodule is checked out) and, when
  `finder/requirements.txt` exists, `pip install` it — mirror HonLib's core +
  `requirements-irc.txt` split.
- `.dockerignore`: drop the `manga_core.py`-era assumptions; keep excluding launchers.

### Rebrand deploy wrappers (env prefix stays `MANGA_DL_*`)
- `docker-compose.yml` / `compose.box.yml`: service + `container_name` `manga-dl` → `galib`;
  traefik router/host `manga.razerblade.dev` labels updated; volumes/env keys unchanged.
- `update.sh`: final echo → GaLib. `git.sh`: unchanged (its `MANGA_DL_GIT_*` overrides stay).
- `README.md`: rewrite for GaLib — intent, Docker run, layout, and an **"Optional modules"**
  section documenting the finder plugin contract and
  `git submodule update --init finder` (model on `HonLib/README.md:170-208`).
- Desktop launchers `manga-dl.command` / `.bat` / `manga-dl-logo.png`: rename to `galib.*`
  and update the wordmark inside.

### Wire the submodule
- `git submodule add https://github.com/east35/GaLib-Finder.git finder` → creates
  `.gitmodules` (mirror `HonLib/.gitmodules`). Commit the pinned finder + `.gitmodules`.

Commit and **push** GaLib (`origin main`).

---

## Files: where each piece lands

| manga-library file | Destination |
| --- | --- |
| `manga_core.py` | **GaLib-Finder** (`finder/weebcentral.py` + `__init__.py` `client`) |
| `app.py` | GaLib (guarded finder import, `/api/features`, gated download, rebrand) |
| `static/**` | GaLib (feature-gate download UI, rebrand) |
| `pick_folder.py`, `Dockerfile`, `docker-compose.yml`, `compose.box.yml`, `update.sh`, `git.sh`, `.env.example`, `.gitignore`, `.dockerignore`, `README.md` | GaLib (rebrand; env prefix unchanged) |
| `manga-dl.command`/`.bat`/`-logo.png` | GaLib as `galib.*` |
| *(new)* `.gitmodules`, `finder/` submodule | GaLib |

The original `manga-library` repo is left untouched (it is the private source).

---

## Verification

**GaLib without the finder** (proves graceful degradation — the whole point):
```sh
cd GaLib
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python app.py            # opens on 8765
```
- `curl localhost:8765/api/features` → `{"finder": false}`
- `curl -X POST localhost:8765/api/download -H 'content-type: application/json' -d '{"url":"x"}'` → **503**
- UI: no "Download manga" button; library + reader of any existing `.cbz` folders work.

**GaLib with the finder** (end-to-end download):
```sh
git submodule update --init finder
.venv/bin/pip install -r finder/requirements.txt
.venv/bin/python app.py
```
- `/api/features` → `{"finder": true}`; download button visible.
- Paste a real `https://weebcentral.com/series/…` URL → a `.cbz` + `details.json` + cover
  land in the library folder; the new series opens in the reader.
- A non-matching URL → 400 (via `finder.matches`).

**GaLib-Finder standalone:** `cd GaLib-Finder && python -m pytest`.

**Docker:** `cd GaLib && docker compose up -d --build` builds and serves (with finder if
its submodule is checked out).
