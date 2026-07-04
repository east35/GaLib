# GaLib

A tiny self-hosted web app to **read your manga library** — with an optional
plugin that downloads new series for you.

- Flask backend that lists your `.cbz` library and streams pages back to a
  built-in, e-reader-friendly (pure black & white) **right-to-left reader**.
- **Server-synced reading progress** — your current chapter + page follow you
  across every device (stored in `progress.json`).
- Installable as a **PWA**.
- The **download half is optional**: it lives in a separate acquisition plugin
  ([GaLib-Finder](https://github.com/east35/GaLib-Finder)) mounted at `finder/`.
  Without it, GaLib is a pure library/reader; with it, GaLib can fetch new
  series into your library.

## Run with Docker

```bash
docker compose up -d --build
```

The app listens on port `8765` inside the container. Two volumes:

| Container path     | Purpose                                  |
| ------------------ | ---------------------------------------- |
| `/data/downloads`  | your manga library (`.cbz` per chapter)  |
| `/data/config`     | persisted config + reading progress      |

Configure them in `docker-compose.yml`. Then open the mapped host port.

### Auth

There is **no login until you set `MANGA_DL_PASSWORD`**. That's convenient on a
trusted home network but means anyone who can reach the port can use the app.
Set a password before exposing it beyond your LAN, and only set
`MANGA_DL_COOKIE_SECURE=1` when every entry point is HTTPS (e.g. behind a
reverse proxy with TLS). See `.env.example`.

## Layout

- `app.py` — Flask server (UI, library + reader APIs, progress, download jobs).
- `static/` — the single-page UI (`index.html`, `app.js`, `style.css`), PWA
  manifest + service worker, and icons.
- `finder/` — optional acquisition plugin (git submodule; see below).
- `galib.command` / `galib.bat` / `pick_folder.py` — desktop launchers (not
  used in the container deployment).

## Optional modules

GaLib ships intentionally light. The downloader is tracked as a git submodule so
the core web app remains fully usable without checking it out.

### Acquisition plugin (`finder/`)

If a Python package exists at `finder/` exposing a `client` object, GaLib
enables its download UI and the `/api/download` endpoint. Without it the
endpoint returns 503 and the download affordances are hidden — the
reader/library stay fully usable. The contract:

```python
# finder/__init__.py
class _Client:
    def matches(self, url: str) -> bool: ...        # does this finder know this URL?
    def download_series(self, url, output, *, chapters=None, log=print, stop=None) -> Path: ...

client = _Client()
```

GaLib reports the plugin's presence at `/api/features` (`{"finder": true}`).
The official plugin is maintained separately and pinned here as a submodule:

```sh
git submodule update --init finder
docker compose up -d --build
```
