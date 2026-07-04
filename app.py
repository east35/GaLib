"""GaLib web wrapper.

A tiny Flask server that:
  - serves the single-page UI
  - kicks off downloads in background threads (with live log streaming)
  - exposes a native folder picker (via tkinter in a subprocess)
  - lists downloaded series and streams individual pages out of .cbz files

The download half is provided by an optional acquisition plugin mounted at
`finder/` (the GaLib-Finder submodule). When it is absent the reader/library
stay fully usable and the download endpoints report 503.
"""
import hmac
import io
import json
import mimetypes
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
import zipfile
from datetime import timedelta
from pathlib import Path

from flask import (
    Flask, abort, jsonify, redirect, render_template_string, request,
    send_file, send_from_directory, session,
)

# Optional acquisition plugin (GaLib-Finder), mounted at finder/. Guard the
# import and validate the client contract so the core stays source-agnostic and
# usable without it.
try:
    from finder import client as _finder
except ImportError:
    _finder = None
FINDER_METHODS = ("matches", "download_series")
HAS_FINDER = _finder is not None and all(
    callable(getattr(_finder, m, None)) for m in FINDER_METHODS
)
finder = _finder if HAS_FINDER else None

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"

# Ensure the PWA manifest is served with a sensible content type.
mimetypes.add_type("application/manifest+json", ".webmanifest")

_CONFIG_DIR = os.environ.get("MANGA_DL_CONFIG_DIR")
if _CONFIG_DIR:
    CONFIG_PATH = Path(_CONFIG_DIR) / "manga-dl-config.json"
else:
    CONFIG_PATH = Path.home() / ".manga-dl-config.json"

DEFAULT_FOLDER = os.environ.get("MANGA_DL_FOLDER") or str(Path.home() / "Manga")
CONTAINER_MODE = os.environ.get("MANGA_DL_CONTAINER") == "1"

# ---------- auth ----------
#
# Login is enabled only when MANGA_DL_PASSWORD is set, so the on-LAN / dev
# instance stays frictionless. Set it (and ideally MANGA_DL_COOKIE_SECURE=1)
# when exposing the app publicly, e.g. behind the Cloudflare reverse proxy.
AUTH_PASSWORD = os.environ.get("MANGA_DL_PASSWORD") or ""
AUTH_USERNAME = os.environ.get("MANGA_DL_USERNAME") or ""  # optional second factor
AUTH_ENABLED = bool(AUTH_PASSWORD)
COOKIE_SECURE = os.environ.get("MANGA_DL_COOKIE_SECURE") == "1"

# Paths reachable before logging in (login form + the assets it needs, plus
# PWA bits so install works at the login screen). Everything else is gated.
PUBLIC_PATHS = {"/login", "/logout", "/style.css", "/manifest.webmanifest",
                "/sw.js", "/favicon.ico"}
PUBLIC_PREFIXES = ("/img/",)


def _load_secret_key():
    """Stable signing key so sessions survive restarts."""
    env = os.environ.get("MANGA_DL_SECRET_KEY")
    if env:
        return env
    path = CONFIG_PATH.parent / "secret_key"
    try:
        if path.exists():
            return path.read_text().strip()
        key = secrets.token_hex(32)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(key)
        return key
    except Exception:
        # Fall back to an ephemeral key (sessions reset on restart).
        return secrets.token_hex(32)


app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="")
app.secret_key = _load_secret_key()
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=COOKIE_SECURE,
    PERMANENT_SESSION_LIFETIME=timedelta(days=90),
)


def _credentials_ok(username, password):
    ok = hmac.compare_digest(password.encode(), AUTH_PASSWORD.encode())
    if AUTH_USERNAME:
        ok = hmac.compare_digest(username.encode(), AUTH_USERNAME.encode()) and ok
    return ok


@app.before_request
def _require_auth():
    if not AUTH_ENABLED or session.get("authed"):
        return None
    p = request.path
    if p in PUBLIC_PATHS or any(p.startswith(pre) for pre in PUBLIC_PREFIXES):
        return None
    if p.startswith("/api/"):
        return jsonify({"ok": False, "error": "auth required"}), 401
    return redirect("/login")


LOGIN_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>GaLib — sign in</title>
  <link rel="icon" href="img/icon-192.png" />
  <link rel="apple-touch-icon" href="img/apple-touch-icon.png" />
  <style>
    :root { --bg:#fff; --fg:#000; }
    @media (prefers-color-scheme: dark) { :root { --bg:#000; --fg:#fff; } }
    * { box-sizing: border-box; }
    html, body { margin:0; height:100%; background:var(--bg); color:var(--fg);
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
    .wrap { min-height:100%; display:flex; align-items:center; justify-content:center; padding:24px; }
    form { width:100%; max-width:320px; border:2px solid var(--fg); padding:24px; display:flex; flex-direction:column; gap:14px; }
    h1 { margin:0; font-size:22px; letter-spacing:.5px; }
    p { margin:0; font-size:13px; }
    input { background:var(--bg); color:var(--fg); border:2px solid var(--fg); padding:12px 14px; font-size:16px; width:100%; }
    button { background:var(--fg); color:var(--bg); border:2px solid var(--fg); padding:12px 14px; font-size:15px; font-weight:700; cursor:pointer; }
    .err { font-size:13px; font-weight:700; }
  </style>
</head>
<body>
  <div class="wrap">
    <form method="post" action="/login">
      <h1>GaLib</h1>
      <p>Sign in to continue.</p>
      {% if show_user %}<input name="username" type="text" placeholder="Username" autocomplete="username" autofocus />{% endif %}
      <input name="password" type="password" placeholder="Password" autocomplete="current-password" {% if not show_user %}autofocus{% endif %} />
      {% if error %}<div class="err">{{ error }}</div>{% endif %}
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>"""


@app.route("/login", methods=["GET", "POST"])
def login():
    if not AUTH_ENABLED or session.get("authed"):
        return redirect("/")
    error = ""
    if request.method == "POST":
        if _credentials_ok(request.form.get("username", ""), request.form.get("password", "")):
            session.permanent = True
            session["authed"] = True
            return redirect("/")
        error = "Incorrect credentials."
    return render_template_string(LOGIN_HTML, error=error, show_user=bool(AUTH_USERNAME))


@app.route("/logout")
def logout():
    session.clear()
    return redirect("/login")


# ---------- config ----------

def load_config():
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text())
        except Exception:
            pass
    return {"folder": DEFAULT_FOLDER}


def save_config(cfg):
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2))


def current_folder():
    if CONTAINER_MODE:
        return DEFAULT_FOLDER
    return load_config().get("folder") or DEFAULT_FOLDER


# ---------- reading progress ----------
#
# Stored server-side (in the persisted config dir) so the resume point follows
# the reader across every device/browser. Shape:
#   {"series": {
#       "<series-dir-name>": {
#           "current": "Chapter 012.cbz",        # last chapter opened
#           "updated": 1234567890.0,
#           "chapters": {
#               "Chapter 012.cbz": {"page": 5, "pages": 20,
#                                    "read": false, "updated": 1234567890.0}
#           }}}}

PROGRESS_PATH = CONFIG_PATH.parent / "progress.json"
progress_lock = threading.Lock()


def load_progress():
    if PROGRESS_PATH.exists():
        try:
            data = json.loads(PROGRESS_PATH.read_text())
            if isinstance(data, dict) and isinstance(data.get("series"), dict):
                return data
        except Exception:
            pass
    return {"series": {}}


def save_progress(data):
    PROGRESS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = PROGRESS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    os.replace(tmp, PROGRESS_PATH)


def reset_series_progress(series):
    """Drop all stored progress (read marks + resume point) for one series."""
    with progress_lock:
        data = load_progress()
        existed = series in data["series"]
        if existed:
            del data["series"][series]
            save_progress(data)
        return existed


def update_progress(series, chapter, *, page=None, pages=None, read=None):
    """Merge a progress update for one chapter and return the series entry."""
    now = time.time()
    with progress_lock:
        data = load_progress()
        s = data["series"].setdefault(series, {"current": None, "chapters": {}})
        s.setdefault("chapters", {})
        ch = s["chapters"].setdefault(chapter, {"page": 0, "pages": 0, "read": False})
        if pages is not None:
            ch["pages"] = int(pages)
        if page is not None:
            ch["page"] = int(page)
        if read is None:
            # Auto-mark read once the last page is reached.
            if ch.get("pages") and ch["page"] >= ch["pages"] - 1:
                ch["read"] = True
        else:
            ch["read"] = bool(read)
        ch["updated"] = now
        # The resume pointer only follows actual reading (a reported page),
        # not bare read/unread toggles.
        if page is not None:
            s["current"] = chapter
        s["updated"] = now
        save_progress(data)
        return s


# ---------- jobs ----------

jobs = {}
jobs_lock = threading.Lock()


def new_job():
    jid = uuid.uuid4().hex[:8]
    with jobs_lock:
        jobs[jid] = {
            "id": jid,
            "lines": [],
            "done": False,
            "ok": None,
            "error": None,
            "cancel": False,
            "started": time.time(),
        }
    return jid


def job_log(jid, line):
    with jobs_lock:
        j = jobs.get(jid)
        if j is not None:
            j["lines"].append(line)


def job_should_stop(jid):
    with jobs_lock:
        j = jobs.get(jid)
        return bool(j and j["cancel"])


def run_download(jid, url, folder, chapters):
    try:
        finder.download_series(
            url,
            folder,
            chapters=chapters or None,
            log=lambda line: job_log(jid, line),
            stop=lambda: job_should_stop(jid),
        )
        with jobs_lock:
            jobs[jid]["ok"] = True
    except Exception as e:
        with jobs_lock:
            jobs[jid]["ok"] = False
            jobs[jid]["error"] = str(e)
            jobs[jid]["lines"].append(f"ERROR: {e}")
    finally:
        with jobs_lock:
            jobs[jid]["done"] = True


# ---------- routes: page ----------

@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


# ---------- routes: config + folder picker ----------

@app.route("/api/config", methods=["GET"])
def get_config():
    folder = current_folder()
    return jsonify({
        "folder": folder,
        "exists": Path(folder).is_dir(),
        "locked": CONTAINER_MODE,
    })


def native_pick_folder(initial):
    """Open the OS folder picker and return the chosen path, or '' if cancelled."""
    if sys.platform == "darwin":
        script = (
            'set p to POSIX path of (choose folder '
            'with prompt "Choose download folder for GaLib"'
        )
        if initial and Path(initial).is_dir():
            script += f' default location POSIX file "{initial}"'
        script += ")\nreturn p"
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=300,
        )
        # User cancel returns non-zero with stderr "User canceled."; treat as empty.
        if result.returncode != 0:
            return ""
        return result.stdout.strip().rstrip("/")

    if sys.platform == "win32":
        ps = (
            "Add-Type -AssemblyName System.Windows.Forms;"
            "$d = New-Object System.Windows.Forms.FolderBrowserDialog;"
            "$d.Description = 'Choose download folder for GaLib';"
            f"$d.SelectedPath = '{(initial or '').replace(chr(39), chr(39)*2)}';"
            "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }"
        )
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True, text=True, timeout=300,
        )
        return result.stdout.strip()

    # Linux fallback: try zenity, then tkinter.
    try:
        result = subprocess.run(
            ["zenity", "--file-selection", "--directory",
             "--title=Choose download folder",
             f"--filename={initial or ''}"],
            capture_output=True, text=True, timeout=300,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except FileNotFoundError:
        pass
    try:
        result = subprocess.run(
            [sys.executable, str(APP_DIR / "pick_folder.py"), initial or ""],
            capture_output=True, text=True, timeout=300,
        )
        return result.stdout.strip()
    except Exception:
        return ""


@app.route("/api/pick-folder", methods=["POST"])
def pick_folder():
    if CONTAINER_MODE:
        return jsonify({
            "ok": False,
            "error": "Folder is set by the container's volume mount.",
            "locked": True,
        })
    initial = current_folder()
    try:
        chosen = native_pick_folder(initial)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    if not chosen:
        return jsonify({"ok": False, "cancelled": True})
    cfg = load_config()
    cfg["folder"] = chosen
    save_config(cfg)
    Path(chosen).mkdir(parents=True, exist_ok=True)
    return jsonify({"ok": True, "folder": chosen})


# ---------- routes: reading progress ----------

@app.route("/api/progress", methods=["GET"])
def get_progress():
    return jsonify(load_progress())


@app.route("/api/progress", methods=["POST"])
def post_progress():
    data = request.get_json(force=True) or {}
    series = (data.get("series") or "").strip()
    chapter = (data.get("chapter") or "").strip()
    if not series or not chapter:
        return jsonify({"ok": False, "error": "series and chapter required"}), 400
    entry = update_progress(
        series, chapter,
        page=data.get("page"),
        pages=data.get("pages"),
        read=data.get("read"),
    )
    return jsonify({"ok": True, "series": series, "entry": entry})


@app.route("/api/progress/reset", methods=["POST"])
def reset_progress_route():
    data = request.get_json(force=True) or {}
    series = (data.get("series") or "").strip()
    if not series:
        return jsonify({"ok": False, "error": "series required"}), 400
    reset_series_progress(series)
    return jsonify({"ok": True, "series": series})


def mark_chapters_read(series, chapter_names):
    """Mark a batch of chapters read in a single write. Returns the entry."""
    now = time.time()
    with progress_lock:
        data = load_progress()
        s = data["series"].setdefault(series, {"current": None, "chapters": {}})
        s.setdefault("chapters", {})
        changed = False
        for name in chapter_names:
            ch = s["chapters"].setdefault(name, {"page": 0, "pages": 0, "read": False})
            if not ch.get("read"):
                ch["read"] = True
                ch["updated"] = now
                changed = True
        if changed:
            s["updated"] = now
            save_progress(data)
        return s


@app.route("/api/progress/read-through", methods=["POST"])
def progress_read_through():
    """Mark every chapter that sorts before `chapter` (and the chapter itself
    when include=true) as read — so jumping ahead catches up the earlier ones."""
    data = request.get_json(force=True) or {}
    series = (data.get("series") or "").strip()
    chapter = (data.get("chapter") or "").strip()
    include = bool(data.get("include", False))
    if not series or not chapter:
        return jsonify({"ok": False, "error": "series and chapter required"}), 400
    files = [p.name for p in chapter_files(safe_series_dir(series))]
    if chapter not in files:
        return jsonify({"ok": False, "error": "unknown chapter"}), 404
    cutoff = files.index(chapter) + (1 if include else 0)
    entry = mark_chapters_read(series, files[:cutoff])
    return jsonify({"ok": True, "series": series, "entry": entry})


# ---------- routes: downloads ----------

@app.route("/api/features")
def features():
    return jsonify({"finder": HAS_FINDER})


@app.route("/api/download", methods=["POST"])
def start_download():
    if not HAS_FINDER:
        return jsonify({"ok": False, "error": "No finder plugin installed"}), 503
    data = request.get_json(force=True) or {}
    url = (data.get("url") or "").strip()
    chapters = (data.get("chapters") or "").strip() or None
    if not url:
        return jsonify({"ok": False, "error": "Missing URL"}), 400
    if not finder.matches(url):
        return jsonify({"ok": False, "error": "Unsupported URL for the installed finder"}), 400

    folder = current_folder()
    Path(folder).mkdir(parents=True, exist_ok=True)

    jid = new_job()
    threading.Thread(
        target=run_download,
        args=(jid, url, folder, chapters),
        daemon=True,
    ).start()
    return jsonify({"ok": True, "job_id": jid})


@app.route("/api/jobs/<jid>", methods=["GET"])
def job_status(jid):
    since = int(request.args.get("since", 0))
    with jobs_lock:
        j = jobs.get(jid)
        if not j:
            return jsonify({"ok": False, "error": "Unknown job"}), 404
        new_lines = j["lines"][since:]
        return jsonify({
            "ok": True,
            "done": j["done"],
            "error": j["error"],
            "success": j["ok"],
            "next": since + len(new_lines),
            "lines": new_lines,
        })


@app.route("/api/jobs/<jid>/cancel", methods=["POST"])
def cancel_job(jid):
    with jobs_lock:
        j = jobs.get(jid)
        if not j:
            return jsonify({"ok": False}), 404
        j["cancel"] = True
    return jsonify({"ok": True})


# ---------- routes: library ----------

def safe_series_dir(name):
    folder = Path(current_folder())
    series = (folder / name).resolve()
    if folder.resolve() not in series.parents and series != folder.resolve():
        abort(404)
    if not series.is_dir():
        abort(404)
    return series


# Chapter number embedded in a "Chapter 100.cbz" / "Chapter 100.5.cbz" filename.
_CHAP_NUM_RE = re.compile(r"(\d+(?:\.\d+)?)")


def chapter_sort_key(path):
    """Sort .cbz chapters by their numeric value, not lexicographically.

    Filenames are zero-padded to 3 digits, so a plain string sort puts
    "Chapter 1000" between "Chapter 100" and "Chapter 101". Extract the number
    and sort on it; files without a number sort last (by name)."""
    m = _CHAP_NUM_RE.search(path.stem)
    return (0, float(m.group(1)), "") if m else (1, 0.0, path.name.lower())


def chapter_files(series_dir):
    return sorted(
        (p for p in series_dir.iterdir() if p.suffix.lower() == ".cbz"),
        key=chapter_sort_key,
    )


@app.route("/api/library", methods=["GET"])
def list_library():
    folder = Path(current_folder())
    if not folder.is_dir():
        return jsonify({"folder": str(folder), "series": []})
    series = []
    for d in sorted(folder.iterdir()):
        if not d.is_dir():
            continue
        chapters = chapter_files(d)
        if not chapters:
            continue
        details = {}
        dj = d / "details.json"
        if dj.exists():
            try:
                details = json.loads(dj.read_text())
            except Exception:
                pass
        series.append({
            "name": d.name,
            "title": details.get("title") or d.name.replace("-", " "),
            "author": details.get("author"),
            "chapter_count": len(chapters),
            "has_cover": True,
        })
    return jsonify({"folder": str(folder), "series": series})


THUMB_SIZE = (300, 450)  # max width × height for library card thumbnails


def _make_thumb(data: bytes, dest: Path) -> bool:
    """Resize image data to THUMB_SIZE and save as JPEG at dest. Returns True on success."""
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(data))
        img.load()
        img = img.convert("RGB")
        img.thumbnail(THUMB_SIZE, Image.LANCZOS)
        tmp = dest.with_suffix(".tmp")
        img.save(tmp, "JPEG", quality=82, optimize=True)
        os.replace(tmp, dest)
        return True
    except Exception:
        return False


@app.route("/api/series/<name>/cover")
def series_cover(name):
    series = safe_series_dir(name)

    # Fast path: serve cached thumbnail.
    thumb = series / "thumb.jpg"
    if thumb.exists():
        return send_file(thumb, mimetype="image/jpeg")

    chapters = chapter_files(series)
    if chapters:
        try:
            with zipfile.ZipFile(chapters[0]) as zf:
                names = cbz_page_names(zf)
                if names:
                    data = zf.read(names[0])
                    if _make_thumb(data, thumb):
                        return send_file(thumb, mimetype="image/jpeg")
                    mime, _ = mimetypes.guess_type(names[0])
                    return send_file(io.BytesIO(data), mimetype=mime or "image/jpeg")
        except Exception:
            pass
    cover = series / "cover.jpg"
    if cover.exists():
        return send_file(cover, mimetype="image/jpeg")
    abort(404)


def read_details(series_dir):
    """Return the series' details.json as a dict (empty if missing/bad)."""
    dj = series_dir / "details.json"
    if dj.exists():
        try:
            data = json.loads(dj.read_text())
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    return {}


@app.route("/api/series/<name>/chapters")
def list_chapters(name):
    series = safe_series_dir(name)
    out = []
    for p in chapter_files(series):
        try:
            with zipfile.ZipFile(p) as zf:
                pages = sum(
                    1 for n in zf.namelist()
                    if not n.lower().endswith("comicinfo.xml")
                    and not n.endswith("/")
                )
        except Exception:
            pages = 0
        out.append({"file": p.name, "pages": pages})
    d = read_details(series)
    details = {
        "title": d.get("title"),
        "author": d.get("author"),
        "artist": d.get("artist"),
        "description": d.get("description"),
        "genre": d.get("genre") or [],
        "status": d.get("status", 0),
    }
    return jsonify({
        "series": name,
        "chapters": out,
        "has_cover": bool(out),
        "details": details,
    })


def cbz_page_names(zf):
    names = [
        n for n in zf.namelist()
        if not n.lower().endswith("comicinfo.xml") and not n.endswith("/")
    ]
    names.sort()
    return names


@app.route("/api/series/<name>/chapters/<chapter>/pages")
def chapter_pages(name, chapter):
    series = safe_series_dir(name)
    path = series / chapter
    if not path.exists() or path.suffix.lower() != ".cbz":
        abort(404)
    with zipfile.ZipFile(path) as zf:
        names = cbz_page_names(zf)
    return jsonify({"pages": len(names)})


def autocrop_page(data):
    """Trim near-uniform margins from a page image and return (bytes, mime).

    Returns None when nothing useful can be cropped (so the caller serves the
    original untouched) or when Pillow isn't available. Margin detection uses a
    row/column projection on a downscaled copy — a whole row/column must be
    >MIN_FRAC content to count, so stray scan specks in the margin don't defeat
    the crop.
    """
    try:
        from PIL import Image
    except Exception:
        return None

    TOL = 0.12        # pixel counts as "content" if it differs from the
    MIN_FRAC = 0.012  # background by >TOL, and a line needs >MIN_FRAC content
    PAD_FRAC = 0.01   # keep a thin margin so we never shave the artwork
    ANALYZE = 500     # longest side of the downscaled analysis copy

    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception:
        return None

    W, H = img.size
    if W < 8 or H < 8:
        return None

    scale = max(W, H) / ANALYZE if max(W, H) > ANALYZE else 1.0
    sw, sh = max(1, int(W / scale)), max(1, int(H / scale))
    small = img.convert("L").resize((sw, sh), Image.BILINEAR)
    px = small.load()

    corners = [px[0, 0], px[sw - 1, 0], px[0, sh - 1], px[sw - 1, sh - 1]]
    bg = sum(corners) / 4.0
    thresh = 255 * TOL

    row_hit = [0] * sh
    col_hit = [0] * sw
    for y in range(sh):
        for x in range(sw):
            if abs(px[x, y] - bg) > thresh:
                row_hit[y] += 1
                col_hit[x] += 1

    row_min = sw * MIN_FRAC
    col_min = sh * MIN_FRAC
    rows = [y for y in range(sh) if row_hit[y] > row_min]
    cols = [x for x in range(sw) if col_hit[x] > col_min]
    if not rows or not cols:
        return None  # blank/near-blank page — leave it alone

    pad_x, pad_y = int(W * PAD_FRAC), int(H * PAD_FRAC)
    left = max(0, int(cols[0] * scale) - pad_x)
    top = max(0, int(rows[0] * scale) - pad_y)
    right = min(W, int((cols[-1] + 1) * scale) + pad_x)
    bottom = min(H, int((rows[-1] + 1) * scale) + pad_y)

    # Not worth re-encoding if we'd trim less than ~3% off every side.
    if (left < W * 0.03 and top < H * 0.03
            and right > W * 0.97 and bottom > H * 0.97):
        return None

    cropped = img.crop((left, top, right, bottom)).convert("RGB")
    out = io.BytesIO()
    cropped.save(out, "JPEG", quality=88)
    out.seek(0)
    return out, "image/jpeg"


@app.route("/api/series/<name>/chapters/<chapter>/page/<int:idx>")
def chapter_page(name, chapter, idx):
    series = safe_series_dir(name)
    path = series / chapter
    if not path.exists() or path.suffix.lower() != ".cbz":
        abort(404)
    with zipfile.ZipFile(path) as zf:
        names = cbz_page_names(zf)
        if idx < 0 or idx >= len(names):
            abort(404)
        data = zf.read(names[idx])
    if request.args.get("crop") == "1":
        result = autocrop_page(data)
        if result is not None:
            buf, mime = result
            return send_file(buf, mimetype=mime)
    mime, _ = mimetypes.guess_type(names[idx])
    return send_file(io.BytesIO(data), mimetype=mime or "image/jpeg")


# ---------- entrypoint ----------

def open_browser_when_ready(port):
    url = f"http://127.0.0.1:{port}/"
    time.sleep(1.0)
    try:
        webbrowser.open(url)
    except Exception:
        pass


def port_is_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def pick_port(preferred):
    if port_is_free(preferred):
        return preferred
    for p in range(preferred + 1, preferred + 50):
        if port_is_free(p):
            print(f"Port {preferred} was in use — using {p} instead.")
            return p
    # last resort: let the OS pick
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    preferred = int(os.environ.get("MANGA_DL_PORT", "8765"))
    host = "0.0.0.0" if CONTAINER_MODE else "127.0.0.1"
    port = preferred if CONTAINER_MODE else pick_port(preferred)
    Path(current_folder()).mkdir(parents=True, exist_ok=True)
    if os.environ.get("MANGA_DL_NO_BROWSER") != "1":
        threading.Thread(target=open_browser_when_ready, args=(port,), daemon=True).start()
    print(f"GaLib running at http://{host}:{port}/  (Ctrl+C to quit)")
    app.run(host=host, port=port, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
