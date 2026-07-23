(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ChapterPicker = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  class ChapterWindow {
    constructor(batchSize = 50) {
      this.batchSize = Math.max(1, batchSize);
      this.generation = 0;
      this.reset([]);
    }

    reset(items, anchorIndex = 0) {
      this.generation += 1;
      this.items = Array.isArray(items) ? items : [];
      const anchor = Math.max(0, Math.min(this.items.length - 1, anchorIndex));
      const lastStart = Math.max(0, this.items.length - this.batchSize);
      this.start = Math.max(
        0,
        Math.min(lastStart, anchor - Math.floor(this.batchSize / 2)),
      );
      this.end = Math.min(this.items.length, this.start + this.batchSize);
      return this.current();
    }

    current() {
      return { index: this.start, items: this.items.slice(this.start, this.end) };
    }

    before() {
      const end = this.start;
      this.start = Math.max(0, this.start - this.batchSize);
      return { index: this.start, items: this.items.slice(this.start, end) };
    }

    after() {
      const start = this.end;
      this.end = Math.min(this.items.length, this.end + this.batchSize);
      return { index: start, items: this.items.slice(start, this.end) };
    }

    get hasBefore() { return this.start > 0; }
    get hasAfter() { return this.end < this.items.length; }
  }

  function displayName(filename) {
    const stem = String(filename || "").replace(/\.cbz$/i, "");
    return stem.replace(/\d+(?:\.\d+)?/, (value) => {
      const [rawWhole, rawFraction] = value.split(".");
      const whole = rawWhole.replace(/^0+(?=\d)/, "");
      if (rawFraction === undefined) return whole;
      const fraction = rawFraction.replace(/0+$/, "");
      return fraction ? `${whole}.${fraction}` : whole;
    });
  }

  function create({ list, scroller, batchSize = 50 }) {
    const window = new ChapterWindow(batchSize);
    let buildRow = () => document.createElement("div");
    let activate = () => {};
    let pendingGeneration = null;

    function rows(batch) {
      const fragment = document.createDocumentFragment();
      batch.items.forEach((chapter, offset) => {
        const row = buildRow(chapter, batch.index + offset);
        row.dataset.chapterIndex = String(batch.index + offset);
        fragment.appendChild(row);
      });
      return fragment;
    }

    function loader(direction) {
      const element = document.createElement("div");
      element.className = `chapter-loader chapter-loader-${direction}`;
      element.setAttribute("role", "status");
      element.textContent = "Loading more chapters…";
      return element;
    }

    function load(direction) {
      const canLoad = direction === "before" ? window.hasBefore : window.hasAfter;
      if (!canLoad || pendingGeneration !== null) return;
      const generation = window.generation;
      pendingGeneration = generation;
      const status = loader(direction);
      if (direction === "before") list.insertBefore(status, list.firstChild);
      else list.appendChild(status);

      requestAnimationFrame(() => {
        if (pendingGeneration !== generation || generation !== window.generation) return;
        pendingGeneration = null;
        const oldHeight = scroller.scrollHeight;
        const oldTop = scroller.scrollTop;
        status.remove();
        const batch = direction === "before" ? window.before() : window.after();
        if (direction === "before") {
          list.insertBefore(rows(batch), list.firstChild);
          scroller.scrollTop = oldTop + scroller.scrollHeight - oldHeight;
        } else {
          list.appendChild(rows(batch));
        }
      });
    }

    scroller.addEventListener("scroll", () => {
      if (scroller.scrollTop <= scroller.clientHeight) load("before");
      else if (
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
        <= scroller.clientHeight
      ) load("after");
    }, { passive: true });

    list.addEventListener("click", (event) => {
      const row = event.target.closest("[data-chapter-index]");
      if (row && list.contains(row)) {
        activate(Number(row.dataset.chapterIndex), event, row);
      }
    });

    function reset(items, rowBuilder, onActivate, anchorIndex = 0) {
      buildRow = rowBuilder;
      activate = onActivate;
      pendingGeneration = null;
      const batch = window.reset(items, anchorIndex);
      list.innerHTML = "";
      scroller.scrollTop = 0;
      list.appendChild(rows(batch));
      const anchor = list.querySelector(`[data-chapter-index="${anchorIndex}"]`);
      if (anchor) anchor.scrollIntoView({ block: "center" });
    }

    function clear() {
      pendingGeneration = null;
      window.reset([]);
      list.innerHTML = "";
    }

    return { reset, clear };
  }

  return { ChapterWindow, create, displayName };
});
