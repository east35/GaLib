// GaLib frontend

const $ = (sel) => document.querySelector(sel);

// True only when the optional finder acquisition plugin (GaLib-Finder) is
// installed. When false, all download affordances are hidden and the
// library/reader stay fully usable. Confirmed via /api/features on boot.
let HAS_FINDER = true;

const els = {
  openDownload: $("#open-download"),
  downloadModal: $("#download-modal"),
  url: $("#series-url"),
  chapters: $("#chapters"),
  download: $("#download"),
  cancel: $("#cancel"),
  log: $("#log"),
  library: $("#library"),
  inprogress: $("#inprogress"),
  inprogressSection: $("#inprogress-section"),
  finished: $("#finished"),
  finishedSection: $("#finished-section"),
  modal: $("#chapters-modal"),
  chaptersTitle: $("#chapters-title"),
  chaptersList: $("#chapters-list"),
  chaptersReset: $("#chapters-reset"),
  seriesDetail: $("#series-detail"),
  navToggle: $("#nav-toggle"),
  navBackdrop: $("#nav-backdrop"),
  topbarActions: $(".topbar-actions"),
  refreshLibrary: $("#refresh-library"),
  reader: $("#reader"),
  readerImg: $("#reader-img"),
  readerChapterBtn: $("#reader-chapter-btn"),
  readerChapterLabel: $("#reader-chapter-label"),
  readerChapterPicker: $("#reader-chapter-picker"),
  readerChapterPickerBackdrop: $("#reader-chapter-picker-backdrop"),
  readerChapterList: $("#reader-chapter-list"),
  readerCounter: $("#reader-counter"),
  readerBar: $(".reader-bar"),
  readerClose: $("#reader-close"),
  readerCrop: $("#reader-crop"),
  readerSpread: $("#reader-spread"),
  readerFullWidth: $("#reader-full-width"),
  readerRefresh: $("#reader-refresh"),
  readerRefreshPanel: $("#reader-refresh-panel"),
  readerRefreshSlider: $("#reader-refresh-slider"),
  readerRefreshValue: $("#reader-refresh-value"),
  readerFlash: $("#reader-flash"),
  readerStage: $(".reader-stage"),
  hitLeft: $("#reader-hit-left"),
  hitCenter: $("#reader-hit-center"),
  hitRight: $("#reader-hit-right"),
  hitSideLeft: $("#reader-hit-side-left"),
  hitSideRight: $("#reader-hit-side-right"),
  transition: $("#reader-transition"),
  transitionLabel: document.querySelector("#reader-transition .rt-label"),
  transitionTitle: document.querySelector("#reader-transition .rt-title"),
};

let currentJob = null;
let pollTimer = null;

// ---------- helpers ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 401) {
    // Session expired / not signed in — bounce to the login page.
    window.location.href = "/login";
    return new Promise(() => {}); // halt this call; navigation is underway
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function initials(title) {
  return title.split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();
}

// ---------- download modal ----------

function openDownloadModal() {
  els.downloadModal.classList.remove("hidden");
  els.url.focus();
}

function closeDownloadModal() {
  els.downloadModal.classList.add("hidden");
}

// ---------- nav drawer (mobile) ----------

function closeNavDrawer() {
  els.topbarActions.classList.remove("open");
  els.navBackdrop.classList.remove("open");
  els.navToggle.setAttribute("aria-expanded", "false");
}

els.navToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = els.topbarActions.classList.toggle("open");
  els.navBackdrop.classList.toggle("open", open);
  els.navToggle.setAttribute("aria-expanded", String(open));
});

els.navBackdrop.addEventListener("click", closeNavDrawer);

els.openDownload.addEventListener("click", closeNavDrawer);
document.querySelector(".topbar-actions .ext").addEventListener("click", closeNavDrawer);

// ---------- refresh ----------

let refreshing = false;
async function refreshLibrary() {
  if (refreshing) return;
  refreshing = true;
  closeNavDrawer();
  els.refreshLibrary.classList.remove("spinning");
  // reflow so the animation restarts on rapid taps
  void els.refreshLibrary.offsetWidth;
  els.refreshLibrary.classList.add("spinning");
  els.refreshLibrary.disabled = true;
  try {
    await loadProgress();
    await loadLibrary();
  } finally {
    refreshing = false;
    els.refreshLibrary.disabled = false;
  }
}
els.refreshLibrary.addEventListener("click", refreshLibrary);
els.refreshLibrary.addEventListener("animationend", () => {
  els.refreshLibrary.classList.remove("spinning");
});

// ---------- download modal ----------

els.openDownload.addEventListener("click", openDownloadModal);
els.downloadModal.addEventListener("click", (e) => {
  if (e.target === els.downloadModal || e.target.hasAttribute("data-close-modal")) {
    closeDownloadModal();
  }
});

els.download.addEventListener("click", async () => {
  const url = els.url.value.trim();
  const chapters = els.chapters.value.trim();
  if (!url) {
    alert("Paste a Weeb Central series link first.");
    return;
  }
  els.log.textContent = "";
  els.log.classList.remove("hidden");
  els.download.disabled = true;
  els.cancel.classList.remove("hidden");
  try {
    const res = await api("/api/download", {
      method: "POST",
      body: JSON.stringify({ url, chapters }),
    });
    if (!res.ok) {
      throw new Error(res.error || "Failed to start");
    }
    currentJob = { id: res.job_id, next: 0 };
    pollJob();
  } catch (e) {
    appendLog("ERROR: " + e.message);
    finishJob();
  }
});

els.cancel.addEventListener("click", async () => {
  if (!currentJob) return;
  await fetch(`/api/jobs/${currentJob.id}/cancel`, { method: "POST" });
  appendLog("Cancelling…");
});

function appendLog(line) {
  els.log.textContent += (els.log.textContent ? "\n" : "") + line;
  els.log.scrollTop = els.log.scrollHeight;
}

async function pollJob() {
  if (!currentJob) return;
  try {
    const res = await api(`/api/jobs/${currentJob.id}?since=${currentJob.next}`);
    currentJob.next = res.next;
    for (const line of res.lines) appendLog(line);
    if (res.done) {
      finishJob();
      loadLibrary();
      return;
    }
  } catch (e) {
    appendLog("Polling error: " + e.message);
  }
  pollTimer = setTimeout(pollJob, 1000);
}

function finishJob() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  currentJob = null;
  els.download.disabled = false;
  els.cancel.classList.add("hidden");
}

// ---------- reading progress (server-synced) ----------

// In-memory mirror of /api/progress, refreshed on load and updated optimistically.
let progress = { series: {} };

async function loadProgress() {
  try {
    const data = await api("/api/progress");
    progress = data && data.series ? data : { series: {} };
  } catch {
    progress = { series: {} };
  }
  await migrateLocalReads();
}

// One-time: lift any read-marks left in this browser's localStorage up to the server.
async function migrateLocalReads() {
  const KEY = "manga-dl.read";
  let raw;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    raw = [];
  }
  if (!Array.isArray(raw) || !raw.length) return;
  for (const k of raw) {
    const idx = k.indexOf("::");
    if (idx < 0) continue;
    const name = k.slice(0, idx);
    const file = k.slice(idx + 2);
    if (isRead(name, file)) continue;
    try {
      await api("/api/progress", {
        method: "POST",
        body: JSON.stringify({ series: name, chapter: file, read: true }),
      });
    } catch {}
  }
  try {
    const data = await api("/api/progress");
    if (data && data.series) progress = data;
  } catch {}
  localStorage.removeItem(KEY);
}

function seriesProgress(name) {
  return progress.series[name] || null;
}

function chapterProgress(name, file) {
  const s = progress.series[name];
  return (s && s.chapters && s.chapters[file]) || null;
}

function isRead(name, file) {
  const c = chapterProgress(name, file);
  return !!(c && c.read);
}

function readCount(name) {
  const s = progress.series[name];
  if (!s || !s.chapters) return 0;
  return Object.values(s.chapters).filter((c) => c && c.read).length;
}

// Push (and locally mirror) a progress update for one chapter.
async function saveProgress(name, file, fields) {
  const s = progress.series[name] || (progress.series[name] = { current: null, chapters: {} });
  if (!s.chapters) s.chapters = {};
  const c = s.chapters[file] || (s.chapters[file] = { page: 0, pages: 0, read: false });
  if (fields.page != null) c.page = fields.page;
  if (fields.pages != null) c.pages = fields.pages;
  if (fields.read != null) c.read = fields.read;
  else if (c.pages && c.page >= c.pages - 1) c.read = true;
  if (fields.page != null) s.current = file;
  try {
    const res = await api("/api/progress", {
      method: "POST",
      body: JSON.stringify({ series: name, chapter: file, ...fields }),
    });
    if (res && res.entry) progress.series[name] = res.entry;
  } catch {}
}

// Reading a chapter implies the earlier ones are done: mark everything that
// sorts before `chapterFile` as read (the current chapter is left alone until
// finished normally). Server resolves the ordering and writes in one go.
async function markReadThrough(name, chapterFile) {
  try {
    const res = await api("/api/progress/read-through", {
      method: "POST",
      body: JSON.stringify({ series: name, chapter: chapterFile }),
    });
    if (res && res.entry) progress.series[name] = res.entry;
  } catch {}
}

// ---------- library ----------

let allSeries = [];

async function loadLibrary() {
  try {
    const res = await api("/api/library");
    allSeries = res.series || [];
    renderSections();
  } catch (e) {
    els.library.innerHTML = `<div class="lib-empty">Couldn't load library: ${e.message}</div>`;
  }
}

// A series is "finished" once every chapter is marked read.
function isFinished(s) {
  return s.chapter_count > 0 && readCount(s.name) >= s.chapter_count;
}

// "In progress" = has a resume pointer and isn't finished.
function isInProgress(s) {
  if (isFinished(s)) return false;
  const sp = seriesProgress(s.name);
  return !!(sp && sp.current);
}

// Fill a hide-when-empty section.
function fillSection(sectionEl, gridEl, items, kind) {
  gridEl.innerHTML = "";
  if (items.length) {
    sectionEl.classList.remove("hidden");
    for (const s of items) gridEl.appendChild(renderCard(s, kind));
  } else {
    sectionEl.classList.add("hidden");
  }
}

function renderSections() {
  const inprog = allSeries.filter(isInProgress);
  const finished = allSeries.filter(isFinished);
  const rest = allSeries.filter((s) => !isInProgress(s) && !isFinished(s));

  fillSection(els.inprogressSection, els.inprogress, inprog, "inprogress");
  fillSection(els.finishedSection, els.finished, finished, "complete");

  // "In Library" is the always-visible section (it holds Refresh).
  els.library.innerHTML = "";
  if (!allSeries.length) {
    els.library.innerHTML = HAS_FINDER
      ? `<div class="lib-empty">Nothing downloaded yet. Tap “Download manga” to start.</div>`
      : `<div class="lib-empty">Your library is empty. Add manga to your library folder to read them here.</div>`;
    return;
  }
  if (!rest.length) {
    els.library.innerHTML = `<div class="lib-empty">Nothing new to start — see the sections above and below.</div>`;
    return;
  }
  for (const s of rest) els.library.appendChild(renderCard(s, "library"));
}

function renderCard(s, kind) {
  const card = document.createElement("div");
  card.className = "series-card";
  const enc = encodeURIComponent(s.name);
  const cover = s.has_cover
    ? `<img class="cover" src="/api/series/${enc}/cover" alt="" loading="lazy">`
    : `<div class="cover-placeholder">${escapeHtml(initials(s.title))}</div>`;

  if (kind === "inprogress") {
    const sp = seriesProgress(s.name);
    const cp = sp && sp.current ? chapterProgress(s.name, sp.current) : null;
    const read = readCount(s.name);
    const niceName = sp && sp.current ? sp.current.replace(/\.cbz$/i, "") : "";
    const where = `pg ${((cp && cp.page) || 0) + 1}/${(cp && cp.pages) || "?"}`;
    let sub = `${s.chapter_count} chapter${s.chapter_count === 1 ? "" : "s"}`;
    if (read) sub += ` · ${read} read`;
    card.innerHTML = `
      ${cover}
      <div class="resume-strip" title="${escapeHtml(niceName)}">
        <span class="resume-ch">${escapeHtml(niceName)}</span>
        <span class="resume-pg">${where}</span>
      </div>
      <div class="series-meta">
        <p class="title">${escapeHtml(s.title)}</p>
        <div class="sub">${sub}</div>
        <div class="card-actions">
          <button class="btn primary act-continue">Continue</button>
          <button class="btn ghost act-chapters">Chapters</button>
        </div>
      </div>
    `;
    card.querySelector(".act-continue").addEventListener("click", (e) => {
      e.stopPropagation();
      continueSeries(s);
    });
    card.querySelector(".act-chapters").addEventListener("click", (e) => {
      e.stopPropagation();
      openChapters(s);
    });
    card.addEventListener("click", () => continueSeries(s));
  } else {
    // Library / Complete: cover + title + count only. Tap the card to browse.
    const sub = `${s.chapter_count} chapter${s.chapter_count === 1 ? "" : "s"}`;
    card.innerHTML = `
      ${cover}
      <div class="series-meta">
        <p class="title">${escapeHtml(s.title)}</p>
        <div class="sub">${sub}</div>
      </div>
    `;
    card.addEventListener("click", () => openChapters(s));
  }
  return card;
}

// ---------- chapter list ----------

let chaptersSeries = null;

const STATUS_LABELS = { 1: "Ongoing", 2: "Completed", 3: "Licensed", 5: "Cancelled", 6: "Hiatus" };

function renderSeriesDetail(series, d, hasCover) {
  d = d || {};
  const cover = hasCover
    ? `<img class="sd-cover" src="/api/series/${encodeURIComponent(series.name)}/cover" alt="">`
    : "";
  const author = d.author ? escapeHtml(d.author) : "";
  const artist = d.artist && d.artist !== d.author ? escapeHtml(d.artist) : "";
  let people = "";
  if (author) people += `<span class="label">Story</span> ${author}`;
  if (artist) people += `${people ? "<br>" : ""}<span class="label">Art</span> ${artist}`;
  const peopleEl = people ? `<div class="sd-people">${people}</div>` : "";
  const status = STATUS_LABELS[d.status];
  const statusEl = status ? `<span class="sd-status">${status}</span>` : "";
  const genres = (d.genre || []).map((g) => `<span class="sd-genre">${escapeHtml(g)}</span>`).join("");
  const genreEl = genres ? `<div class="sd-genres">${genres}</div>` : "";
  const desc = d.description ? `<p class="sd-desc">${escapeHtml(d.description)}</p>` : "";

  if (!cover && !peopleEl && !statusEl && !genreEl && !desc) {
    els.seriesDetail.innerHTML = ""; // nothing to show; CSS hides the empty box
    return;
  }
  els.seriesDetail.innerHTML = `
    <div class="sd-top">
      ${cover}
      <div class="sd-meta">${peopleEl}${statusEl}${genreEl}</div>
    </div>
    ${desc}
  `;
}

async function openChapters(series) {
  chaptersSeries = series;
  els.chaptersTitle.textContent = series.title;
  els.seriesDetail.innerHTML = "";
  els.chaptersList.innerHTML = "<div class='lib-empty' style='padding:18px'>Loading…</div>";
  els.modal.classList.remove("hidden");
  try {
    const res = await api(`/api/series/${encodeURIComponent(series.name)}/chapters`);
    renderSeriesDetail(series, res.details, res.has_cover);
    if (!res.chapters.length) {
      els.chaptersList.innerHTML = "<div class='lib-empty' style='padding:18px'>No chapters yet.</div>";
      return;
    }
    const sp = seriesProgress(series.name);
    const currentFile = sp && sp.current;
    els.chaptersList.innerHTML = "";
    for (const [i, ch] of res.chapters.entries()) {
      const row = document.createElement("div");
      row.className = "chap-item";
      const cp = chapterProgress(series.name, ch.file);
      if (cp && cp.read) row.classList.add("read");
      if (ch.file === currentFile) row.classList.add("current");
      const niceName = ch.file.replace(/\.cbz$/i, "");
      let badge = "";
      if (ch.file === currentFile && cp && !cp.read) {
        badge = `<span class="chap-badge">on pg ${cp.page + 1}/${ch.pages}</span>`;
      } else if (cp && !cp.read && cp.page > 0) {
        badge = `<span class="chap-badge faint">pg ${cp.page + 1}/${ch.pages}</span>`;
      }
      row.innerHTML = `
        <button class="chap-read" title="Toggle read" aria-label="Toggle read">
          <span class="check">✓</span>
        </button>
        <span class="chap-name">${escapeHtml(niceName)}</span>
        ${badge}
        <span class="pages">${ch.pages} pages</span>
      `;
      row.addEventListener("click", () => {
        closeModal();
        const start = cp && !cp.read ? (cp.page || 0) : 0;
        openReader(series, res.chapters, i, start);
      });
      row.querySelector(".chap-read").addEventListener("click", (e) => {
        e.stopPropagation();
        const nowRead = !row.classList.contains("read");
        saveProgress(series.name, ch.file, { read: nowRead });
        row.classList.toggle("read", nowRead);
      });
      els.chaptersList.appendChild(row);
    }
  } catch (e) {
    els.chaptersList.innerHTML = `<div class='lib-empty' style='padding:18px'>Error: ${e.message}</div>`;
  }
}

function closeModal() {
  els.modal.classList.add("hidden");
}

els.modal.addEventListener("click", (e) => {
  if (e.target === els.modal || e.target.hasAttribute("data-close-modal")) closeModal();
});

// Wipe all read marks + the resume point for the open series, after confirming.
els.chaptersReset.addEventListener("click", async () => {
  if (!chaptersSeries) return;
  const ok = confirm(
    `Reset all reading progress for “${chaptersSeries.title}”?\n\n` +
    `This clears read marks and the resume point for every chapter. It can't be undone.`
  );
  if (!ok) return;
  try {
    await api("/api/progress/reset", {
      method: "POST",
      body: JSON.stringify({ series: chaptersSeries.name }),
    });
    delete progress.series[chaptersSeries.name];
    openChapters(chaptersSeries); // re-render the list with marks cleared
    loadLibrary();                // drop it out of "Continue reading"
  } catch (e) {
    alert("Couldn't reset progress: " + e.message);
  }
});

// Resume a series at its saved chapter + page (advancing past a finished chapter).
async function continueSeries(series) {
  const sp = seriesProgress(series.name);
  if (!sp || !sp.current) {
    openChapters(series);
    return;
  }
  try {
    const res = await api(`/api/series/${encodeURIComponent(series.name)}/chapters`);
    let idx = res.chapters.findIndex((c) => c.file === sp.current);
    if (idx < 0) {
      openChapters(series);
      return;
    }
    const cp = chapterProgress(series.name, sp.current);
    let start = 0;
    if (cp && cp.read) {
      // Current chapter is finished — jump to the next one if it exists.
      if (idx + 1 < res.chapters.length) idx += 1;
    } else if (cp) {
      start = cp.page || 0;
    }
    openReader(series, res.chapters, idx, start);
  } catch (e) {
    alert("Couldn't resume: " + e.message);
  }
}

// ---------- reader (right-to-left) ----------

let reader = null;

async function openReader(series, chapters, chapIdx, startPage = 0) {
  const chapter = chapters[chapIdx];
  const res = await api(
    `/api/series/${encodeURIComponent(series.name)}/chapters/${encodeURIComponent(chapter.file)}/pages`
  );
  reader = {
    series: series.name,
    seriesTitle: series.title,
    chapters,
    chapIdx,
    chapter: chapter.file,
    pages: res.pages,
    index: Math.min(Math.max(0, startPage), Math.max(0, res.pages - 1)),
  };
  pageTurnsSinceRefresh = 0;
  updateReaderTitle();
  markReadThrough(series.name, chapter.file); // catch up earlier chapters
  els.reader.classList.remove("hidden");
  els.reader.focus();
  document.body.classList.add("reader-open"); // lock the page behind it
  // Push a history entry so the device/browser Back button closes the reader
  // instead of leaving the app.
  history.pushState({ readerOpen: true }, "");
  showPage();
}

function updateReaderTitle() {
  const niceName = reader.chapter.replace(/\.cbz$/i, "");
  els.readerChapterLabel.textContent = niceName;
}

// ---------- reader chapter picker ----------

function openChapterPicker() {
  if (!reader) return;
  closeRefreshPanel();
  const cur = reader.chapIdx;
  els.readerChapterList.innerHTML = "";
  reader.chapters.forEach((ch, i) => {
    const item = document.createElement("div");
    item.className = "rcp-item" + (i === cur ? " current" : "");
    item.textContent = ch.file.replace(/\.cbz$/i, "");
    item.addEventListener("click", () => {
      closeChapterPicker();
      // Always start the chosen chapter at page 0 (lets you restart a chapter).
      if (i !== reader.chapIdx) switchChapter(i, false);
    });
    els.readerChapterList.appendChild(item);
  });
  els.readerChapterPicker.classList.add("open");
  // Scroll the current chapter into view.
  const curEl = els.readerChapterList.querySelector(".current");
  if (curEl) curEl.scrollIntoView({ block: "center" });
}

function closeChapterPicker() {
  els.readerChapterPicker.classList.remove("open");
}

els.readerChapterBtn.addEventListener("click", openChapterPicker);
els.readerChapterPickerBackdrop.addEventListener("click", closeChapterPicker);

let transitionTimer = null;

function showChapterTransition(direction, ch) {
  const niceName = ch.file.replace(/\.cbz$/i, "");
  els.transitionLabel.textContent =
    direction === "next" ? "Next chapter" : "Previous chapter";
  els.transitionTitle.textContent = niceName;
  els.transition.classList.add("show");
  if (transitionTimer) clearTimeout(transitionTimer);
  transitionTimer = setTimeout(() => {
    els.transition.classList.remove("show");
  }, 1100);
}

async function switchChapter(newIdx, startAtEnd) {
  const ch = reader.chapters[newIdx];
  const direction = newIdx > reader.chapIdx ? "next" : "prev";
  // The chapter list doesn't carry page counts — fetch before swapping in,
  // otherwise reader.pages is undefined and the boundary checks in
  // nextPage/prevPage skip every page of the new chapter.
  const seriesName = reader.series;
  const res = await api(
    `/api/series/${encodeURIComponent(seriesName)}/chapters/${encodeURIComponent(ch.file)}/pages`
  );
  if (!reader || reader.series !== seriesName) return; // reader closed mid-await
  reader.chapIdx = newIdx;
  reader.chapter = ch.file;
  reader.pages = res.pages;
  reader.index = startAtEnd ? Math.max(0, res.pages - 1) : 0;
  reader.pageEdge = startAtEnd ? "bottom" : "top";
  updateReaderTitle();
  markReadThrough(reader.series, ch.file); // catch up earlier chapters
  showChapterTransition(direction, ch);
  showPage();
}

// Crop empty margins (server-side). Opt-in, persisted, applies to all pages.
let cropEnabled = false;
try { cropEnabled = localStorage.getItem("manga-dl.crop") === "1"; } catch (_) {}

function updateCropSwitch() {
  els.readerCrop.setAttribute("aria-pressed", cropEnabled ? "true" : "false");
}

// Spread mode: rotate landscape (two-page) pages 90° to fill a portrait screen.
// Opt-in, persisted. Detection is by the loaded image's aspect ratio.
let spreadEnabled = false;
try { spreadEnabled = localStorage.getItem("manga-dl.spread") === "1"; } catch (_) {}

function updateSpreadSwitch() {
  els.readerSpread.setAttribute("aria-pressed", spreadEnabled ? "true" : "false");
}

// Full-width mode scales portrait pages to the viewport width. Page-turn taps
// first move through any vertically cropped content, one viewport at a time.
// Reuse HonLib's column-constraint glyphs: framed lines for constrained pages,
// edge-to-edge lines for full-width pages.
const WIDTH_CONSTRAINED_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="20" height="20"><path d="M4 4v16M20 4v16" /><path d="M9 8h6M9 12h6M9 16h6" /></svg>';
const WIDTH_FULL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="20" height="20"><path d="M3 8h18M3 12h18M3 16h18" /></svg>';
let fullWidthEnabled = false;
try { fullWidthEnabled = localStorage.getItem("manga-dl.fullWidth") === "1"; } catch (_) {}

function updateFullWidthSwitch() {
  els.readerFullWidth.setAttribute("aria-pressed", fullWidthEnabled ? "true" : "false");
  els.readerFullWidth.innerHTML = fullWidthEnabled ? WIDTH_FULL_SVG : WIDTH_CONSTRAINED_SVG;
  els.readerStage.classList.toggle("full-width-active", fullWidthEnabled);
}

// E-ink page refresh: after N forward page turns, flash the screen solid
// black→white to force a full waveform refresh and clear ghosting. 0 = off.
// Opt-in, persisted. Counts only forward turns (like the read direction).
let refreshEvery = 0;
try { refreshEvery = clampRefresh(localStorage.getItem("manga-dl.refresh")); } catch (_) {}
let pageTurnsSinceRefresh = 0;
let refreshFlashTimer = null;

function clampRefresh(v) {
  return Math.max(0, Math.min(25, Math.round(Number(v) || 0)));
}

function formatRefreshEvery(v) {
  return v > 0 ? `After ${v} ${v === 1 ? "page" : "pages"}` : "Off";
}

function updateRefreshButton() {
  els.readerRefresh.setAttribute("aria-pressed", refreshEvery > 0 ? "true" : "false");
  els.readerRefresh.title = refreshEvery > 0
    ? `Page refresh: after ${refreshEvery} ${refreshEvery === 1 ? "page" : "pages"}`
    : "Page refresh: off";
}

function updateRefreshPanelUI() {
  els.readerRefreshSlider.value = String(refreshEvery);
  els.readerRefreshValue.textContent = formatRefreshEvery(refreshEvery);
}

function closeRefreshPanel() {
  els.readerRefreshPanel.classList.add("hidden");
}

function toggleRefreshPanel() {
  if (els.readerRefreshPanel.classList.contains("hidden")) {
    updateRefreshPanelUI();
    els.readerRefreshPanel.classList.remove("hidden");
  } else {
    closeRefreshPanel();
  }
}

// Count one forward page turn; flash when the threshold is reached.
function noteForwardTurn() {
  if (!refreshEvery) return;
  pageTurnsSinceRefresh += 1;
  if (pageTurnsSinceRefresh >= refreshEvery) {
    pageTurnsSinceRefresh = 0;
    triggerReaderRefreshFlash();
  }
}

function triggerReaderRefreshFlash() {
  const flash = els.readerFlash;
  if (!flash) return;
  clearTimeout(refreshFlashTimer);
  // Paint solid black, hold, then solid white, hold — each long enough for the
  // panel to settle. A fast fade doesn't trigger a global e-ink update.
  flash.classList.remove("hidden", "phase-black", "phase-white");
  void flash.offsetWidth; // restart the transition from a clean state
  flash.classList.add("phase-black");
  refreshFlashTimer = setTimeout(() => {
    flash.classList.remove("phase-black");
    flash.classList.add("phase-white");
    refreshFlashTimer = setTimeout(() => {
      flash.classList.remove("phase-white");
      flash.classList.add("hidden");
    }, 400);
  }, 400);
}

// ---------- pinch-to-zoom ----------
// A translate+scale (composed with spread's rotate) applied inline to
// #reader-img. Pointer events on the stage drive it — two fingers pinch,
// one finger pans while zoomed, and a double-tap toggles between 1× and 2.5×.
const MAX_ZOOM = 5;
let zoomState = { scale: 1, tx: 0, ty: 0 };
const activePointers = new Map();
let pinchStart = null;
let panStart = null;
let suppressNextClick = false;
let clearSuppressTimer = null;
let lastTapAt = 0;
let lastTapPos = null;

function isZoomed() { return zoomState.scale > 1.001; }

function applyZoomTransform() {
  const img = els.readerImg;
  const spread = els.readerStage.classList.contains("spread-active");
  const parts = [];
  if (zoomState.tx || zoomState.ty) parts.push(`translate(${zoomState.tx}px, ${zoomState.ty}px)`);
  if (zoomState.scale !== 1) parts.push(`scale(${zoomState.scale})`);
  if (spread) parts.push("rotate(90deg)");
  img.style.transform = parts.join(" ");
  els.reader.classList.toggle("is-zoomed", isZoomed());
}

function resetZoom() {
  zoomState = { scale: 1, tx: 0, ty: 0 };
  applyZoomTransform();
}

function clampPan() {
  const stage = els.readerStage.getBoundingClientRect();
  const w = els.readerImg.offsetWidth * zoomState.scale;
  const h = els.readerImg.offsetHeight * zoomState.scale;
  const maxX = Math.max(0, (w - stage.width) / 2);
  const maxY = Math.max(0, (h - stage.height) / 2);
  zoomState.tx = Math.max(-maxX, Math.min(maxX, zoomState.tx));
  zoomState.ty = Math.max(-maxY, Math.min(maxY, zoomState.ty));
}

function stageLocal(clientX, clientY) {
  const r = els.readerStage.getBoundingClientRect();
  return { x: clientX - (r.left + r.width / 2), y: clientY - (r.top + r.height / 2) };
}

function armSuppressClick() {
  suppressNextClick = true;
  clearTimeout(clearSuppressTimer);
  // Clicks synthesized from touchend arrive within ~300ms; clear shortly after.
  clearSuppressTimer = setTimeout(() => { suppressNextClick = false; }, 400);
}

function onStagePointerDown(e) {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  activePointers.set(e.pointerId, stageLocal(e.clientX, e.clientY));
  try { els.readerStage.setPointerCapture(e.pointerId); } catch (_) {}
  if (activePointers.size === 2) {
    const [a, b] = [...activePointers.values()];
    pinchStart = {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      scale: zoomState.scale,
      tx: zoomState.tx,
      ty: zoomState.ty,
    };
    panStart = null;
    armSuppressClick();
    e.preventDefault();
  } else if (activePointers.size === 1 && isZoomed()) {
    const p = [...activePointers.values()][0];
    panStart = { x: p.x, y: p.y, tx: zoomState.tx, ty: zoomState.ty };
  }
}

function onStagePointerMove(e) {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.set(e.pointerId, stageLocal(e.clientX, e.clientY));
  if (activePointers.size >= 2 && pinchStart) {
    const [a, b] = [...activePointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    let s = pinchStart.scale * (d / pinchStart.dist);
    s = Math.max(1, Math.min(MAX_ZOOM, s));
    const ratio = s / pinchStart.scale;
    zoomState.scale = s;
    // Keep the content point under the initial midpoint anchored under the
    // current midpoint (handles simultaneous pinch + pan).
    zoomState.tx = m.x - ratio * (pinchStart.mid.x - pinchStart.tx);
    zoomState.ty = m.y - ratio * (pinchStart.mid.y - pinchStart.ty);
    clampPan();
    applyZoomTransform();
    armSuppressClick();
    e.preventDefault();
  } else if (activePointers.size === 1 && panStart && isZoomed()) {
    const p = [...activePointers.values()][0];
    zoomState.tx = panStart.tx + (p.x - panStart.x);
    zoomState.ty = panStart.ty + (p.y - panStart.y);
    clampPan();
    applyZoomTransform();
    armSuppressClick();
    e.preventDefault();
  }
}

function onStagePointerUp(e) {
  activePointers.delete(e.pointerId);
  if (activePointers.size < 2) pinchStart = null;
  if (activePointers.size < 1) panStart = null;
  if (zoomState.scale <= 1.001) {
    // Snap back cleanly if a pinch out-then-in ended below 1×.
    resetZoom();
  }
}

function onStageClickCapture(e) {
  if (suppressNextClick) {
    suppressNextClick = false;
    clearTimeout(clearSuppressTimer);
    e.stopImmediatePropagation();
    e.preventDefault();
    return;
  }
  // While zoomed, single taps must not turn the page, and a double-tap
  // exits the zoom cleanly. (We don't offer double-tap-to-zoom-in because
  // it would race with the existing tap-to-turn-page gesture on every tap.)
  if (!isZoomed()) return;
  const now = Date.now();
  const pos = stageLocal(e.clientX, e.clientY);
  const isDouble =
    lastTapAt && now - lastTapAt < 300 && lastTapPos &&
    Math.hypot(pos.x - lastTapPos.x, pos.y - lastTapPos.y) < 40;
  if (isDouble) {
    resetZoom();
    lastTapAt = 0;
    lastTapPos = null;
  } else {
    lastTapAt = now;
    lastTapPos = pos;
  }
  e.stopImmediatePropagation();
  e.preventDefault();
}

els.readerStage.addEventListener("pointerdown", onStagePointerDown);
els.readerStage.addEventListener("pointermove", onStagePointerMove);
els.readerStage.addEventListener("pointerup", onStagePointerUp);
els.readerStage.addEventListener("pointercancel", onStagePointerUp);
els.readerStage.addEventListener("click", onStageClickCapture, true);

// Rotate + size a page for spread mode, given the image's natural dimensions
// (falling back to the live <img> when not supplied). A page is a "spread" when
// it's wider than it is tall; sizing makes that landscape image fit the portrait
// stage once rotated 90°.
function applySpreadLayout(natW, natH) {
  const img = els.readerImg;
  if (!natW || !natH) { natW = img.naturalWidth; natH = img.naturalHeight; }
  const active = !fullWidthEnabled && spreadEnabled && natW > 0 && natW > natH;
  els.readerStage.classList.toggle("spread-active", active);
  if (!active) {
    img.style.width = "";
    img.style.height = "";
    applyZoomTransform();
    return;
  }
  const sw = els.readerStage.clientWidth;
  const sh = els.readerStage.clientHeight;
  const ar = natW / natH; // > 1 (landscape)
  // After rotating 90°, a box of width Wd / height Hd occupies (Hd × Wd) on
  // screen. Fit into the stage: Hd ≤ sw and Wd = ar·Hd ≤ sh.
  const Hd = Math.min(sw, sh / ar);
  img.style.width = ar * Hd + "px";
  img.style.height = Hd + "px";
  applyZoomTransform();
}

// Re-apply from the currently displayed image (resize / fullscreen / toggle).
function updateSpreadLayout() { applySpreadLayout(); }

window.addEventListener("resize", updateSpreadLayout);

function pageUrl(idx) {
  const u = `/api/series/${encodeURIComponent(reader.series)}/chapters/${encodeURIComponent(reader.chapter)}/page/${idx}`;
  return cropEnabled ? u + "?crop=1" : u;
}

// Bumped on every page turn so a slow decode from an old turn can't apply late.
let pageToken = 0;

async function showPage() {
  if (!reader) return;
  const token = ++pageToken;
  const url = pageUrl(reader.index);
  els.readerCounter.textContent = `${reader.index + 1} / ${reader.pages}`;
  saveReaderProgress();

  // Decode the next page off-screen FIRST, so we know its orientation before the
  // visible <img> shows it. The current page stays put while this runs — then we
  // swap the image content and its rotation together in a single repaint, so
  // e-ink never sees the un-rotated frame flash to rotated.
  const probe = new Image();
  probe.src = url;
  try {
    await probe.decode();
  } catch (_) {
    // decode() unsupported/failed — fall through; the load handler will catch up.
  }
  if (token !== pageToken || !reader) return; // a newer turn superseded this one

  resetZoom();
  applySpreadLayout(probe.naturalWidth, probe.naturalHeight);
  els.readerImg.src = url;
  // New pages start at the top when reading forward and at the bottom when
  // reading backward. Waiting a frame lets the new full-width image establish
  // its scroll height before the edge is selected.
  const edge = reader.pageEdge || "top";
  reader.pageEdge = "top";
  try { await els.readerImg.decode(); } catch (_) {}
  if (token !== pageToken || !reader) return;
  requestAnimationFrame(() => {
    if (token !== pageToken || !reader) return;
    els.readerStage.scrollTop = edge === "bottom"
      ? Math.max(0, els.readerStage.scrollHeight - els.readerStage.clientHeight)
      : 0;
  });

  // preload the following page
  if (reader.index + 1 < reader.pages) {
    const pre = new Image();
    pre.src = pageUrl(reader.index + 1);
  }
}

// Safety net for the rare path where decode() didn't give us dimensions in time.
els.readerImg.addEventListener("load", updateSpreadLayout);

// Debounce progress writes so rapid page turns don't spam the server.
let progressSaveTimer = null;
function saveReaderProgress() {
  if (!reader) return;
  const { series, chapter, index, pages } = reader;
  if (progressSaveTimer) clearTimeout(progressSaveTimer);
  progressSaveTimer = setTimeout(() => {
    saveProgress(series, chapter, { page: index, pages });
  }, 300);
}

function nextPage() {
  if (!reader) return;
  closeRefreshPanel();
  if (fullWidthEnabled) {
    const stage = els.readerStage;
    const bottom = Math.max(0, stage.scrollHeight - stage.clientHeight);
    if (stage.scrollTop < bottom - 1) {
      stage.scrollTo({ top: Math.min(bottom, stage.scrollTop + stage.clientHeight), behavior: "smooth" });
      return;
    }
  }
  if (reader.index < reader.pages - 1) {
    reader.index++;
    reader.pageEdge = "top";
    noteForwardTurn();
    showPage();
  } else if (reader.chapIdx + 1 < reader.chapters.length) {
    noteForwardTurn();
    switchChapter(reader.chapIdx + 1, false);
  }
}

function prevPage() {
  if (!reader) return;
  closeRefreshPanel();
  if (fullWidthEnabled && els.readerStage.scrollTop > 1) {
    els.readerStage.scrollTo({
      top: Math.max(0, els.readerStage.scrollTop - els.readerStage.clientHeight),
      behavior: "smooth",
    });
    return;
  }
  if (reader.index > 0) {
    reader.index--;
    reader.pageEdge = "bottom";
    showPage();
  } else if (reader.chapIdx > 0) {
    switchChapter(reader.chapIdx - 1, true);
  }
}

// Actual teardown. Safe to call more than once.
function closeReaderUI() {
  if (els.reader.classList.contains("hidden")) return;
  closeChapterPicker();
  closeRefreshPanel();
  // Cancel any in-flight flash so it can't linger over the library.
  clearTimeout(refreshFlashTimer);
  els.readerFlash.classList.add("hidden");
  els.readerFlash.classList.remove("phase-black", "phase-white");
  // Flush any pending progress write before tearing the reader down.
  if (progressSaveTimer) { clearTimeout(progressSaveTimer); progressSaveTimer = null; }
  if (reader) saveProgress(reader.series, reader.chapter, { page: reader.index, pages: reader.pages });
  resetZoom();
  els.reader.classList.add("hidden");
  els.readerImg.src = "";
  els.transition.classList.remove("show");
  if (transitionTimer) { clearTimeout(transitionTimer); transitionTimer = null; }
  reader = null;
  document.body.classList.remove("reader-open");
  loadLibrary();  // reflect the new resume point on the cards
}

// User-initiated close (button / Esc / bar tap): unwind the history entry we
// pushed on open, which fires popstate -> closeReaderUI. Falls back to a direct
// teardown if that entry isn't there.
function closeReader() {
  if (history.state && history.state.readerOpen) {
    history.back();
  } else {
    closeReaderUI();
  }
}

// Back button (or our own history.back above) closes the reader, not the app.
window.addEventListener("popstate", closeReaderUI);

// RTL: clicking the LEFT side advances forward (toward next page); RIGHT side goes back.
els.hitLeft.addEventListener("click", nextPage);
els.hitRight.addEventListener("click", prevPage);
els.hitCenter.addEventListener("click", toggleFullscreen);
els.hitSideLeft.addEventListener("click", nextPage);
els.hitSideRight.addEventListener("click", prevPage);
els.readerStage.addEventListener("click", (e) => {
  if (!fullWidthEnabled || isZoomed()) return;
  const rect = els.readerStage.getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (x < rect.width / 3) nextPage();
  else if (x > rect.width * 2 / 3) prevPage();
  else toggleFullscreen();
});
els.readerClose.addEventListener("click", closeReader);
els.readerCrop.addEventListener("click", () => {
  cropEnabled = !cropEnabled;
  try { localStorage.setItem("manga-dl.crop", cropEnabled ? "1" : "0"); } catch (_) {}
  updateCropSwitch();
  if (reader) showPage();
});
els.readerSpread.addEventListener("click", () => {
  spreadEnabled = !spreadEnabled;
  try { localStorage.setItem("manga-dl.spread", spreadEnabled ? "1" : "0"); } catch (_) {}
  updateSpreadSwitch();
  resetZoom();
  updateSpreadLayout();
});
els.readerFullWidth.addEventListener("click", () => {
  fullWidthEnabled = !fullWidthEnabled;
  try { localStorage.setItem("manga-dl.fullWidth", fullWidthEnabled ? "1" : "0"); } catch (_) {}
  updateFullWidthSwitch();
  resetZoom();
  updateSpreadLayout();
  els.readerStage.scrollTop = 0;
});
els.readerRefresh.addEventListener("click", toggleRefreshPanel);
els.readerRefreshSlider.addEventListener("input", () => {
  refreshEvery = clampRefresh(els.readerRefreshSlider.value);
  pageTurnsSinceRefresh = 0;
  try { localStorage.setItem("manga-dl.refresh", String(refreshEvery)); } catch (_) {}
  updateRefreshButton();
  updateRefreshPanelUI();
});
updateCropSwitch();
updateSpreadSwitch();
updateFullWidthSwitch();
updateRefreshButton();

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    (els.reader.requestFullscreen
      ? els.reader.requestFullscreen()
      : Promise.reject()
    ).catch(() => {});
  }
}

document.addEventListener("fullscreenchange", () => {
  els.reader.classList.toggle("is-fullscreen", !!document.fullscreenElement);
  updateSpreadLayout(); // stage resizes when the bar hides/shows
});

document.addEventListener("keydown", (e) => {
  if (els.reader.classList.contains("hidden")) return;
  if (els.readerChapterPicker.classList.contains("open")) {
    if (e.key === "Escape") closeChapterPicker();
    return; // picker open: swallow page-turn keys
  }
  if (e.key === "Escape") closeReader();
  else if (e.key === "ArrowLeft") nextPage();   // RTL: left arrow = forward
  else if (e.key === "ArrowRight") prevPage();  // RTL: right arrow = back
  else if (e.key === " ") { e.preventDefault(); nextPage(); }
});

// ---------- theme (system / light / dark) ----------

const THEME_KEY = "manga-dl.theme";
const themeButtons = document.querySelectorAll(".theme-toggle [data-theme-set]");
const systemDark = window.matchMedia
  ? window.matchMedia("(prefers-color-scheme: dark)")
  : null;

function currentThemeMode() {
  const m = localStorage.getItem(THEME_KEY);
  return m === "light" || m === "dark" ? m : "system";
}

// True when the page is actually rendering dark, accounting for "system".
function effectiveDark(mode) {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return !!(systemDark && systemDark.matches);
}

function applyTheme(mode) {
  if (mode === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", mode);
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", effectiveDark(mode) ? "#000000" : "#ffffff");
  for (const b of themeButtons) {
    b.classList.toggle("active", b.dataset.themeSet === mode);
  }
}

function setTheme(mode) {
  if (mode === "system") localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, mode);
  applyTheme(mode);
}

for (const b of themeButtons) {
  b.addEventListener("click", () => setTheme(b.dataset.themeSet));
}
// Keep the status bar colour (and a re-render trigger) in sync while on "system".
if (systemDark) {
  systemDark.addEventListener("change", () => {
    if (currentThemeMode() === "system") applyTheme("system");
  });
}
applyTheme(currentThemeMode());

// ---------- feature detection ----------

// Hide every download affordance when the finder plugin isn't installed, so the
// app degrades to a pure library/reader.
async function loadFeatures() {
  try {
    const features = await api("/api/features");
    HAS_FINDER = !!features.finder;
  } catch {
    HAS_FINDER = false;
  }
  if (!HAS_FINDER) {
    els.openDownload?.classList.add("hidden");
    els.downloadModal?.classList.add("hidden");
    document.querySelector(".topbar-actions .ext")?.classList.add("hidden");
  }
}

// ---------- init ----------

loadFeatures().then(() => loadProgress().then(loadLibrary));

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
