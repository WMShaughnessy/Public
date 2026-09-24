/**
 * Gallery — Gallery_script.js
 *
 * Builds the gallery entirely from the photo folder in the repo, so adding
 * photos only needs a push — no code changes.
 *
 * Features:
 *  - Folder listing via the GitHub API (one request, cached in localStorage)
 *  - Subfolders are albums; the folder name is a tag on every photo inside
 *  - Optional sidecar text file per photo (Title / Caption / Tags / Date)
 *  - Photo date read from EXIF metadata (JPEG, PNG, WebP), cached per file
 *  - Views: Slideshow (default), chronological Feed
 *  - Album / tag filters shared by both views
 *  - Expanded view (native resolution) and Full Screen
 *  - Keyboard (← → Esc), swipe, auto-play, and linkable URL hash state
 */

/* ============================================================
   CONFIG
   ============================================================ */

const DEFAULT_CONFIG = {
  title: "Gallery",
  owner: "WMShaughnessy",
  repo: "Public",
  branch: "main",
  imagesDir: "Gallery_images",
  cacheTTLMinutes: 15,
  defaultView: "slideshow",
  newestFirst: true,
  slideshowSeconds: 6,
};

const CFG = Object.assign({}, DEFAULT_CONFIG, window.GALLERY_CONFIG || {});
const TREE_CACHE_KEY = "Gallery_tree";
const META_CACHE_KEY = "Gallery_meta";

const IMAGE_EXTS          = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif"]);
const EXIF_HEAD_BYTES     = 256 * 1024;        // EXIF lives in the first 64 KB of a JPEG
const FULL_SCAN_MAX_BYTES = 25 * 1024 * 1024;  // PNG/WebP may store EXIF at the end
const META_CONCURRENCY    = 4;
const VIEWS               = ["slideshow", "feed"];

/* ============================================================
   STATE
   ============================================================ */

let allPhotos    = [];    // every photo, sorted
let viewPhotos   = [];    // allPhotos after the active tag filter
let tagIndex     = new Map(); // tag key → { key, label, album, count }
let activeTag    = null;  // tag key or null = all
let activeView   = VIEWS.includes(CFG.defaultView) ? CFG.defaultView : "slideshow";
let newestFirst  = CFG.newestFirst !== false;
let slideIndex   = 0;
let isLoading    = false;
let playTimer    = null;
let viewerMode   = null;  // null (closed) | "native" | "fit"
let fsOwnedByViewer = false;
let listingInfo  = null;  // { savedAt, fromCache, stale, error }
let pendingHash  = null;  // hash state to apply once photos load

/* ============================================================
   HELPERS
   ============================================================ */

function escHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function extOf(path) {
  const m = /\.([^./]+)$/.exec(path);
  return m ? m[1].toLowerCase() : "";
}

function stripExt(path) {
  return path.replace(/\.[^./]+$/, "");
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function photoUrl(path) {
  return `${encodePath(CFG.imagesDir)}/${encodePath(path)}`;
}

function tagKey(label) {
  return String(label).trim().replace(/\s+/g, " ").toLowerCase();
}

function prettyName(filename) {
  return stripExt(filename).replace(/[_-]+/g, " ").trim();
}

const COLORS = ["red", "yellow", "blue"];

function colorForIndex(i) {
  return COLORS[i % COLORS.length];
}

function relativeTime(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)    return "just now";
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

/* ============================================================
   DATES
   Dates are kept as wall-clock strings ("YYYY-MM-DDTHH:MM:SS") exactly as
   the camera recorded them. EXIF has no reliable timezone, so converting
   through UTC would shift photos by the viewer's offset.
   ============================================================ */

function pad2(n) { return String(n).padStart(2, "0"); }

function buildDate(y, mo, d, h, mi, s) {
  y = +y; mo = +mo; d = +d;
  if (y < 1800 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const hasTime = h !== undefined && h !== null && h !== "";
  h = hasTime ? +h : 0; mi = hasTime ? +(mi || 0) : 0; s = hasTime ? +(s || 0) : 0;
  if (h > 23 || mi > 59 || s > 59) return null;
  return {
    iso: `${y}-${pad2(mo)}-${pad2(d)}T${pad2(h)}:${pad2(mi)}:${pad2(s)}`,
    hasTime,
  };
}

/** "2024-05-12", "2024:05:12 18:42:07", "2024/05/12 6:42", "2024-05-12T18:42" */
function parseLooseDate(str) {
  if (!str) return null;
  const m = /^\s*(\d{4})[-:/.](\d{1,2})[-:/.](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(str);
  return m ? buildDate(m[1], m[2], m[3], m[4], m[5], m[6]) : null;
}

/** Fallback: a date embedded in the file name, e.g. IMG_20240512_184207.jpg */
function dateFromFilename(name) {
  const m = /(?:^|\D)((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[-_ T.]?([01]\d|2[0-3])[-_.:]?([0-5]\d)[-_.:]?([0-5]\d))?(?:\D|$)/.exec(name);
  return m ? buildDate(m[1], m[2], m[3], m[4], m[5], m[6]) : null;
}

function dateParts(iso) {
  const [d, t] = iso.split("T");
  const [y, mo, day] = d.split("-").map(Number);
  const [h, mi] = (t || "0:0").split(":").map(Number);
  return new Date(y, mo - 1, day, h, mi);
}

function formatPhotoDate(photo) {
  if (!photo.date) return "Undated";
  const opts = { weekday: "short", month: "short", day: "numeric", year: "numeric" };
  if (photo.hasTime) Object.assign(opts, { hour: "numeric", minute: "2-digit" });
  return dateParts(photo.date).toLocaleString("en-US", opts);
}

function monthLabel(photo) {
  if (!photo.date) return "Undated";
  return dateParts(photo.date).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/* ============================================================
   EXIF — minimal reader for the capture date only
   ============================================================ */

/**
 * Find the TIFF header inside a JPEG (APP1), PNG (eXIf) or WebP (EXIF chunk).
 * Returns the offset, null if the file has no EXIF, or -1 if the buffer ran
 * out before the answer was known.
 */
function locateTiff(v) {
  const len = v.byteLength;
  if (len < 12) return -1;

  // JPEG
  if (v.getUint16(0) === 0xFFD8) {
    let off = 2;
    while (off + 4 <= len) {
      if (v.getUint8(off) !== 0xFF) return null;
      const marker = v.getUint8(off + 1);
      if (marker === 0xFF) { off++; continue; }                         // fill byte
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD8)) { off += 2; continue; }
      if (marker === 0xDA || marker === 0xD9) return null;              // image data reached
      const size = v.getUint16(off + 2);
      if (marker === 0xE1 && off + 10 <= len &&
          v.getUint32(off + 4) === 0x45786966 && v.getUint16(off + 8) === 0) {
        return off + 10;                                                // "Exif\0\0"
      }
      off += 2 + size;
    }
    return -1;
  }

  // PNG
  if (v.getUint32(0) === 0x89504E47 && v.getUint32(4) === 0x0D0A1A0A) {
    let off = 8;
    while (off + 8 <= len) {
      const size = v.getUint32(off);
      const type = v.getUint32(off + 4);
      if (type === 0x65584966) return off + 8;                          // eXIf
      if (type === 0x49454E44) return null;                             // IEND
      off += 12 + size;
    }
    return -1;
  }

  // WebP
  if (v.getUint32(0) === 0x52494646 && v.getUint32(8) === 0x57454250) {
    let off = 12;
    while (off + 8 <= len) {
      const type = v.getUint32(off);
      const size = v.getUint32(off + 4, true);
      if (type === 0x45584946) {                                        // EXIF
        let start = off + 8;
        if (start + 6 <= len && v.getUint32(start) === 0x45786966 && v.getUint16(start + 4) === 0) start += 6;
        return start;
      }
      off += 8 + size + (size & 1);
    }
    return off === len ? null : -1;                                   // every chunk read
  }

  return null;
}

function readTiffDate(v, t) {
  const order = v.getUint16(t);
  if (order !== 0x4949 && order !== 0x4D4D) return null;
  const le  = order === 0x4949;
  const u16 = o => v.getUint16(t + o, le);
  const u32 = o => v.getUint32(t + o, le);
  if (u16(2) !== 42) return null;

  const readIfd = (ifd) => {
    const tags = {};
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e     = ifd + 2 + i * 12;
      const tag   = u16(e);
      const type  = u16(e + 2);
      const count = u32(e + 4);
      if (tag === 0x8769) {
        tags[tag] = u32(e + 8);                                         // Exif sub-IFD
      } else if (type === 2 && (tag === 0x0132 || tag === 0x9003 || tag === 0x9004)) {
        const start = count <= 4 ? e + 8 : u32(e + 8);
        let s = "";
        for (let k = 0; k < count && k < 64; k++) {
          const c = v.getUint8(t + start + k);
          if (!c) break;
          s += String.fromCharCode(c);
        }
        tags[tag] = s;
      }
    }
    return tags;
  };

  const ifd0 = readIfd(u32(4));
  let exif = {};
  if (ifd0[0x8769]) {
    try { exif = readIfd(ifd0[0x8769]); } catch {}
  }
  // DateTimeOriginal → DateTimeDigitized → DateTime (last modified)
  for (const raw of [exif[0x9003], exif[0x9004], ifd0[0x0132]]) {
    const parsed = parseLooseDate(raw);
    if (parsed) return parsed;
  }
  return null;
}

/** Returns a date, null (no date in the file) or undefined (need more bytes). */
function exifDateFromBuffer(buf) {
  try {
    const v = new DataView(buf);
    const tiff = locateTiff(v);
    if (tiff === -1) return undefined;
    if (tiff === null) return null;
    return readTiffDate(v, tiff);
  } catch {
    return undefined;
  }
}

/** Read up to maxBytes from the start of a file without downloading the rest. */
async function fetchHead(url, maxBytes) {
  const res = await fetch(url, { headers: { Range: `bytes=0-${maxBytes - 1}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (res.status === 206 || !res.body || !res.body.getReader) return res.arrayBuffer();

  // Server ignored the Range header — stream and stop early.
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  reader.cancel().catch(() => {});
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out.buffer;
}

async function readExifDate(photo) {
  const url = photoUrl(photo.path);
  let found = exifDateFromBuffer(await fetchHead(url, EXIF_HEAD_BYTES));
  if (found === undefined && photo.size > EXIF_HEAD_BYTES && photo.size <= FULL_SCAN_MAX_BYTES) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    found = exifDateFromBuffer(await res.arrayBuffer());
  }
  return found || null;
}

/* ============================================================
   SIDECAR TEXT FILES
   photo.jpg + photo.txt:
     Title: Optional headline
     Caption: Free text — any line without a key continues the caption.
     Tags: nyc, sunset, water
     Date: 2024-05-12 18:42   (optional; overrides the photo's metadata)
   ============================================================ */

function parseSidecar(text) {
  const out = { title: "", caption: "", tags: [], date: null };
  const captionLines = [];
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const m = /^\s*(title|caption|tags?|date)\s*:\s*(.*)$/i.exec(raw);
    if (!m) { captionLines.push(raw.trim()); continue; }
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "title")        out.title = val;
    else if (key === "date")    out.date  = parseLooseDate(val);
    else if (key === "caption") captionLines.push(val);
    else out.tags.push(...val.split(/[,;]/).map(s => s.trim().replace(/^#/, "")).filter(Boolean));
  }
  out.caption = captionLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

/* ============================================================
   LISTING (GitHub API) + CACHING (localStorage)
   ============================================================ */

function treeCacheId() {
  return [CFG.owner, CFG.repo, CFG.branch, CFG.imagesDir].join("|").toLowerCase();
}

async function fetchListing(force) {
  const cached = readJSON(TREE_CACHE_KEY);
  const usable = cached && cached.id === treeCacheId() && Array.isArray(cached.entries);
  const ttlMs  = CFG.cacheTTLMinutes * 60 * 1000;
  if (usable && !force && Date.now() - cached.savedAt < ttlMs) {
    return { entries: cached.entries, savedAt: cached.savedAt, fromCache: true };
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(CFG.owner)}/${encodeURIComponent(CFG.repo)}` +
              `/git/trees/${encodeURIComponent(CFG.branch)}:${encodePath(CFG.imagesDir)}?recursive=1`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    let entries;
    if (res.status === 404) {
      entries = [];                                     // folder not created yet
    } else if (!res.ok) {
      const limited = (res.status === 403 || res.status === 429) &&
                      res.headers.get("x-ratelimit-remaining") === "0";
      throw new Error(limited
        ? "GitHub API rate limit reached — try again later"
        : `GitHub API returned HTTP ${res.status}`);
    } else {
      const data = await res.json();
      entries = (data.tree || [])
        .filter(t => t.type === "blob")
        .map(t => ({ path: t.path, sha: t.sha, size: t.size || 0 }));
    }
    const savedAt = Date.now();
    writeJSON(TREE_CACHE_KEY, { id: treeCacheId(), savedAt, entries });
    return { entries, savedAt, fromCache: false };
  } catch (err) {
    if (usable) {
      return { entries: cached.entries, savedAt: cached.savedAt, fromCache: true, stale: true, error: err.message };
    }
    throw err;
  }
}

function buildPhotos(entries) {
  const texts  = new Map();   // lower-cased path without extension → entry
  const images = [];
  for (const e of entries) {
    const parts = e.path.split("/");
    // Skip hidden files and anything GitHub Pages (Jekyll) won't publish.
    if (parts.some(p => /^[._#~]/.test(p))) continue;
    const ext = extOf(e.path);
    if (IMAGE_EXTS.has(ext)) images.push(e);
    else if (ext === "txt") texts.set(stripExt(e.path).toLowerCase(), e);
  }

  return images.map(e => {
    const folders = e.path.split("/");
    const name    = folders.pop();
    const sidecar = texts.get(stripExt(e.path).toLowerCase()) || texts.get(e.path.toLowerCase()) || null;
    return {
      path: e.path,
      name,
      sha: e.sha,
      size: e.size,
      folders,
      sidecar,
      title: "",
      caption: "",
      tags: [],
      date: null,
      hasTime: false,
    };
  });
}

async function runPool(tasks, limit) {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      await task();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

/**
 * Fill in sidecar text and EXIF dates. Both are cached by git blob SHA, so
 * a file is only re-read after it changes. Failures (e.g. a photo pushed
 * moments ago that Pages hasn't published yet) are not cached.
 */
async function loadMetadata(photos, onProgress) {
  const cache = readJSON(META_CACHE_KEY) || {};
  const keep  = {};
  let done = 0;

  const tasks = photos.map(photo => async () => {
    let sidecar = null;
    if (photo.sidecar) {
      const key = "t:" + photo.sidecar.sha;
      let text = typeof cache[key] === "string" ? cache[key] : null;
      if (text === null) {
        try {
          const res = await fetch(photoUrl(photo.sidecar.path));
          if (res.ok) text = await res.text();
        } catch {}
      }
      if (text !== null) {
        keep[key] = text;
        sidecar = parseSidecar(text);
      }
    }

    const exifKey = "x:" + photo.sha;
    let exif = cache[exifKey];
    if (exif === undefined && !(sidecar && sidecar.date)) {
      try {
        const found = await readExifDate(photo);
        exif = found ? { d: found.iso, t: found.hasTime } : { d: null };
      } catch {
        exif = undefined;
      }
    }
    if (exif !== undefined) keep[exifKey] = exif;

    const exifDate = exif && exif.d ? { iso: exif.d, hasTime: exif.t !== false } : null;
    const date = (sidecar && sidecar.date) || exifDate || dateFromFilename(photo.name);
    photo.date    = date ? date.iso : null;
    photo.hasTime = date ? date.hasTime : false;

    photo.title   = sidecar ? sidecar.title : "";
    photo.caption = sidecar ? sidecar.caption : "";
    const seen = new Set();
    photo.tags = [];
    for (const [label, album] of [
      ...photo.folders.map(f => [f, true]),
      ...(sidecar ? sidecar.tags : []).map(t => [t, false]),
    ]) {
      const key = tagKey(label);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      photo.tags.push({ key, label: label.trim(), album });
    }

    onProgress(++done, photos.length);
  });

  await runPool(tasks, META_CONCURRENCY);
  writeJSON(META_CACHE_KEY, keep);
}

/* ============================================================
   SORT + FILTER
   ============================================================ */

function sortPhotos() {
  allPhotos.sort((a, b) => {
    if (a.date && !b.date) return -1;                 // undated always last
    if (!a.date && b.date) return 1;
    if (a.date && b.date && a.date !== b.date) {
      return newestFirst ? (a.date < b.date ? 1 : -1) : (a.date < b.date ? -1 : 1);
    }
    return a.path.localeCompare(b.path, undefined, { numeric: true });
  });
}

function buildTagIndex() {
  tagIndex = new Map();
  for (const p of allPhotos) {
    for (const t of p.tags) {
      const entry = tagIndex.get(t.key);
      if (entry) {
        entry.count++;
        entry.album = entry.album || t.album;
      } else {
        tagIndex.set(t.key, { key: t.key, label: t.label, album: t.album, count: 1 });
      }
    }
  }
}

function applyFilter() {
  if (activeTag && !tagIndex.has(activeTag)) activeTag = null;
  viewPhotos = activeTag
    ? allPhotos.filter(p => p.tags.some(t => t.key === activeTag))
    : allPhotos.slice();
}

/* ============================================================
   URL HASH  (#view=feed&tag=iceland&photo=Iceland/glacier.jpg)
   ============================================================ */

function readHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  return {
    view:  params.get("view"),
    tag:   params.get("tag"),
    photo: params.get("photo"),
  };
}

function writeHash() {
  const params = new URLSearchParams();
  params.set("view", activeView);
  if (activeTag) params.set("tag", activeTag);
  if (activeView === "slideshow" && viewPhotos[slideIndex]) params.set("photo", viewPhotos[slideIndex].path);
  try { history.replaceState(null, "", "#" + params.toString()); } catch {}
}

/* ============================================================
   RENDER — header + stats bar + controls
   ============================================================ */

function renderHeader() {
  const now     = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric" });
  const timeStr = now.toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit" });

  const titleEl = document.getElementById("header-title");
  if (titleEl) titleEl.innerHTML = '<a href="index.html" style="color:inherit;text-decoration:none;">' + escHtml(CFG.title) + '</a>';
  document.title = CFG.title;

  const dateEl = document.getElementById("header-date");
  if (dateEl) dateEl.textContent = dateStr.toUpperCase();

  const timeEl = document.getElementById("header-time");
  if (timeEl) timeEl.textContent = timeStr;
}

function renderStatsBar() {
  const el = document.getElementById("stats-count-label");
  if (!el) return;
  if (isLoading && !allPhotos.length) { el.textContent = "— PHOTOS"; return; }
  const total  = allPhotos.length;
  const albums = [...tagIndex.values()].filter(t => t.album).length;
  const plural = (n, w) => `${n} ${w}${n !== 1 ? "S" : ""}`;
  if (activeTag) {
    const label = tagIndex.get(activeTag).label.toUpperCase();
    el.textContent = `${viewPhotos.length} OF ${plural(total, "PHOTO")} · ${label}`;
  } else {
    el.textContent = plural(total, "PHOTO") + (albums ? ` · ${plural(albums, "ALBUM")}` : "");
  }
}

function renderViewButtons() {
  document.querySelectorAll(".view-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === activeView);
  });
  const sortBtn = document.getElementById("sort-btn");
  if (sortBtn) sortBtn.textContent = newestFirst ? "Newest First" : "Oldest First";
}

function filterButton(entry) {
  const active = entry ? activeTag === entry.key : activeTag === null;
  const label  = entry ? escHtml(entry.label) : "All";
  const count  = entry ? `<span class="filter-count">${entry.count}</span>` : "";
  return `<button class="filter-btn${active ? " active" : ""}" data-tag="${entry ? escHtml(entry.key) : ""}">${label}${count}</button>`;
}

function renderFilters() {
  const wrap = document.getElementById("filter-buttons");
  if (!wrap) return;
  const entries = [...tagIndex.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  const albums  = entries.filter(t => t.album);
  const tags    = entries.filter(t => !t.album);
  if (!entries.length) { wrap.innerHTML = ""; return; }

  let html = filterButton(null);
  if (albums.length) {
    html += `<span class="filter-break"></span><span class="filter-group-label">Albums</span>` + albums.map(filterButton).join("");
  }
  if (tags.length) {
    html += `<span class="filter-break"></span><span class="filter-group-label">Tags</span>` + tags.map(filterButton).join("");
  }
  wrap.innerHTML = html;
}

function renderLastUpdated() {
  const el = document.getElementById("last-updated");
  if (!el) return;
  if (!listingInfo) { el.textContent = ""; return; }
  el.textContent = (listingInfo.fromCache ? "Cached · " : "Live · ") + relativeTime(listingInfo.savedAt);
}

/* ============================================================
   RENDER — shared photo details
   ============================================================ */

function tagChipsHtml(photo) {
  return photo.tags.map(t => {
    const cls = (t.album ? "card-source" : "card-category") + (t.key === activeTag ? " active" : "");
    return `<button class="${cls}" data-act="tag" data-tag="${escHtml(t.key)}" title="Show ${escHtml(t.album ? "album" : "tag")}: ${escHtml(t.label)}">${escHtml(t.label)}</button>`;
  }).join("");
}

function detailsHtml(photo, { withTime = true } = {}) {
  return `
    ${withTime ? `<div class="card-time">${escHtml(formatPhotoDate(photo))}</div>` : ""}
    <div class="card-meta">${tagChipsHtml(photo)}</div>`;
}

function captionHtml(photo) {
  return `
    ${photo.title   ? `<div class="card-title">${escHtml(photo.title)}</div>` : ""}
    ${photo.caption ? `<div class="card-preview">${escHtml(photo.caption)}</div>` : ""}`;
}

function altText(photo) {
  return photo.title || photo.caption.split("\n")[0] || prettyName(photo.name);
}

/* ============================================================
   RENDER — slideshow
   ============================================================ */

function renderSlideshow() {
  const wrapper = document.getElementById("gallery-wrapper");
  if (!wrapper) return;
  const n = viewPhotos.length;
  if (!n) { wrapper.innerHTML = noticeHtml() + emptyHtml(); return; }
  slideIndex = ((slideIndex % n) + n) % n;
  const photo = viewPhotos[slideIndex];

  wrapper.innerHTML = noticeHtml() + `
<div class="article-card slide-card">
  <div class="card-accent ${colorForIndex(slideIndex)}"></div>
  <div class="card-body">
    ${detailsHtml(photo)}
    <div class="slide-stage" id="slide-stage">
      <img src="${escHtml(photoUrl(photo.path))}" alt="${escHtml(altText(photo))}" decoding="async" data-act="expand" title="Expand">
      ${n > 1 ? `
      <button class="slide-hit prev" data-act="prev" aria-label="Previous photo"><span>←</span></button>
      <button class="slide-hit next" data-act="next" aria-label="Next photo"><span>→</span></button>` : ""}
    </div>
    <div class="slide-nav">
      <div class="controls">
        <button class="refresh-btn" data-act="prev" aria-label="Previous photo"${n > 1 ? "" : " disabled"}>← Prev</button>
        <span class="slide-counter">${slideIndex + 1} / ${n}</span>
        <button class="refresh-btn" data-act="next" aria-label="Next photo"${n > 1 ? "" : " disabled"}>Next →</button>
      </div>
      <div class="controls">
        <button class="refresh-btn${playTimer ? " active" : ""}" data-act="play" data-play-btn${n > 1 ? "" : " disabled"}>${playTimer ? "Pause" : "Play"}</button>
        <button class="refresh-btn" data-act="expand">Expand</button>
        <button class="refresh-btn" data-act="fullscreen">Full Screen</button>
      </div>
    </div>
    ${captionHtml(photo)}
  </div>
</div>`;

  preloadNeighbors();
}

function preloadNeighbors() {
  const n = viewPhotos.length;
  if (n < 2) return;
  for (const d of [1, -1]) {
    const img = new Image();
    img.decoding = "async";
    img.src = photoUrl(viewPhotos[(slideIndex + d + n) % n].path);
  }
}

/* ============================================================
   RENDER — chronological feed
   ============================================================ */

function renderFeed() {
  const wrapper = document.getElementById("gallery-wrapper");
  if (!wrapper) return;
  if (!viewPhotos.length) { wrapper.innerHTML = noticeHtml() + emptyHtml(); return; }

  const parts = [noticeHtml()];
  let lastMonth = null;
  viewPhotos.forEach((photo, i) => {
    const month = monthLabel(photo);
    if (month !== lastMonth) {
      parts.push(`<div class="feed-month">${escHtml(month)}</div>`);
      lastMonth = month;
    }
    parts.push(`
<div class="article-card feed-card">
  <div class="card-accent ${colorForIndex(i)}"></div>
  <div class="card-body">
    ${detailsHtml(photo)}
    <button class="feed-image" data-act="open" data-index="${i}" aria-label="Open in slideshow">
      <img src="${escHtml(photoUrl(photo.path))}" alt="${escHtml(altText(photo))}" loading="lazy" decoding="async">
    </button>
    ${captionHtml(photo)}
  </div>
</div>`);
  });
  wrapper.innerHTML = parts.join("");
}

/* ============================================================
   RENDER — status / empty / error
   ============================================================ */

function noticeHtml() {
  if (!listingInfo || !listingInfo.stale) return "";
  return `<div class="notice-card">⚠ Showing saved listing · ${escHtml(listingInfo.error || "GitHub unavailable")}</div>`;
}

function emptyHtml() {
  if (activeTag) return `<div class="empty-state">No photos tagged “${escHtml(tagIndex.get(activeTag)?.label || activeTag)}”</div>`;
  return `<div class="empty-state">No photos yet · add images to ${escHtml(CFG.imagesDir)}/</div>`;
}

function showLoadingState(text) {
  const wrapper = document.getElementById("gallery-wrapper");
  if (!wrapper) return;
  wrapper.innerHTML = `
<div class="status-row" id="loading-status-row">
  <div class="spinner"></div>
  <span id="loading-text">${escHtml(text)}</span>
  <div class="progress-bar-wrap">
    <div class="progress-bar" id="progress-bar" style="width:0%"></div>
  </div>
</div>`;
}

function updateProgress(done, total) {
  const bar  = document.getElementById("progress-bar");
  const text = document.getElementById("loading-text");
  if (bar)  bar.style.width = `${Math.round((done / total) * 100)}%`;
  if (text) text.textContent = `Reading ${done} / ${total} photos…`;
}

function showLoadError(message) {
  const wrapper = document.getElementById("gallery-wrapper");
  if (wrapper) wrapper.innerHTML = `<div class="error-card">⚠ ${escHtml(message)}</div>`;
}

/* ============================================================
   RENDER — main
   ============================================================ */

function render() {
  applyFilter();
  renderStatsBar();
  renderViewButtons();
  renderFilters();
  renderLastUpdated();
  if (activeView === "feed") renderFeed();
  else renderSlideshow();
  writeHash();
}

/* ============================================================
   NAVIGATION + PLAYBACK
   ============================================================ */

function setView(view) {
  if (!VIEWS.includes(view) || view === activeView) return;
  if (view !== "slideshow") stopPlay();
  activeView = view;
  render();
}

function setTag(key) {
  const current = viewPhotos[slideIndex];
  activeTag = key || null;
  applyFilter();
  // Keep the photo on screen if it survives the filter; otherwise start over.
  const idx = current ? viewPhotos.indexOf(current) : -1;
  slideIndex = idx >= 0 ? idx : 0;
  render();
}

function showSlide(index) {
  const n = viewPhotos.length;
  if (!n) return;
  slideIndex = ((index % n) + n) % n;
  if (viewerMode) renderViewer();
  else if (activeView === "slideshow") renderSlideshow();
  writeHash();
}

function step(delta, fromTimer) {
  if (!fromTimer && playTimer) restartPlay();
  showSlide(slideIndex + delta);
}

function syncPlayButtons() {
  document.querySelectorAll("[data-play-btn]").forEach(btn => {
    btn.textContent = playTimer ? "Pause" : "Play";
    btn.classList.toggle("active", !!playTimer);
  });
}

function startPlay() {
  if (playTimer || viewPhotos.length < 2) return;
  playTimer = setInterval(() => step(1, true), Math.max(1, CFG.slideshowSeconds) * 1000);
  syncPlayButtons();
}

function stopPlay() {
  if (!playTimer) return;
  clearInterval(playTimer);
  playTimer = null;
  syncPlayButtons();
}

function restartPlay() {
  stopPlay();
  startPlay();
}

/* ============================================================
   VIEWER — Expanded (native resolution) + Full Screen
   ============================================================ */

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function fullscreenSupported() {
  const el = document.documentElement;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen);
}

function enterFullscreen(el) {
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req) return;
  try {
    const p = req.call(el);
    if (p && p.catch) p.catch(() => { fsOwnedByViewer = false; renderViewerChrome(); });
  } catch {}
}

function exitFullscreen() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (exit && fullscreenElement()) {
    try {
      const p = exit.call(document);
      if (p && p.catch) p.catch(() => {});
    } catch {}
  }
}

function openViewer(mode, fullscreen) {
  if (!viewPhotos.length) return;
  const viewer = document.getElementById("viewer");
  viewerMode = mode;
  viewer.classList.add("open");
  document.body.classList.add("viewer-open");
  if (fullscreen && fullscreenSupported()) {
    fsOwnedByViewer = true;
    enterFullscreen(viewer);
  }
  renderViewer();
  const closeBtn = viewer.querySelector('[data-act="close"]');
  if (closeBtn) closeBtn.focus({ preventScroll: true });
}

function closeViewer() {
  if (!viewerMode) return;
  const viewer = document.getElementById("viewer");
  viewerMode = null;
  fsOwnedByViewer = false;
  exitFullscreen();
  viewer.classList.remove("open", "mode-native", "mode-fit");
  document.body.classList.remove("viewer-open");
  document.getElementById("viewer-img").removeAttribute("src");
  if (activeView === "slideshow") renderSlideshow();
  writeHash();
}

function toggleViewerFullscreen() {
  if (fullscreenElement()) {
    fsOwnedByViewer = false;                   // leaving by button keeps the viewer open
    exitFullscreen();
  } else {
    fsOwnedByViewer = true;
    viewerMode = "fit";
    enterFullscreen(document.getElementById("viewer"));
    renderViewer();
  }
}

function renderViewerChrome() {
  const viewer = document.getElementById("viewer");
  viewer.classList.toggle("mode-native", viewerMode === "native");
  viewer.classList.toggle("mode-fit", viewerMode === "fit");

  const modeBtn = document.getElementById("viewer-mode");
  if (modeBtn) modeBtn.textContent = viewerMode === "native" ? "Fit to Screen" : "Actual Size";

  const fsBtn = document.getElementById("viewer-fs");
  if (fsBtn) {
    fsBtn.hidden = !fullscreenSupported();
    fsBtn.textContent = fullscreenElement() ? "Exit Full Screen" : "Full Screen";
  }
  viewer.querySelectorAll('[data-act="prev"], [data-act="next"], [data-act="play"]').forEach(b => {
    b.disabled = viewPhotos.length < 2;
  });
  syncPlayButtons();
}

function renderViewerCount(img) {
  const count = document.getElementById("viewer-count");
  if (!count) return;
  const dims = img && img.naturalWidth ? ` · ${img.naturalWidth} × ${img.naturalHeight} px` : "";
  count.textContent = `${slideIndex + 1} / ${viewPhotos.length}${dims}`;
}

function renderViewer() {
  const n = viewPhotos.length;
  if (!n || !viewerMode) return;
  slideIndex = ((slideIndex % n) + n) % n;
  const photo  = viewPhotos[slideIndex];
  const img    = document.getElementById("viewer-img");
  const scroll = document.getElementById("viewer-scroll");

  renderViewerChrome();
  renderViewerCount(null);

  const src = photoUrl(photo.path);
  img.onload = () => {
    renderViewerCount(img);
    // Start the native-size view centred on the photo.
    scroll.scrollLeft = (scroll.scrollWidth  - scroll.clientWidth)  / 2;
    scroll.scrollTop  = (scroll.scrollHeight - scroll.clientHeight) / 2;
  };
  if (img.getAttribute("src") !== src) {
    img.src = src;
  } else if (img.complete) {
    img.onload();
  }
  img.alt = altText(photo);

  const caption = document.getElementById("viewer-caption");
  caption.innerHTML = `${detailsHtml(photo)}${captionHtml(photo)}`.trim();
  preloadNeighbors();
}

function onFullscreenChange() {
  // Esc (or the browser's own control) closes full screen — close the viewer with it.
  if (!viewerMode) return;
  if (!fullscreenElement() && fsOwnedByViewer) closeViewer();
  else renderViewerChrome();
}

/* ============================================================
   INPUT — clicks, keys, swipes
   ============================================================ */

function handleAction(btn) {
  const act = btn.dataset.act;
  if (act === "prev")            step(-1);
  else if (act === "next")       step(1);
  else if (act === "play")       playTimer ? stopPlay() : startPlay();
  else if (act === "expand")     openViewer("native", false);
  else if (act === "fullscreen") viewerMode ? toggleViewerFullscreen() : openViewer("fit", true);
  else if (act === "close")      closeViewer();
  else if (act === "mode")       { viewerMode = viewerMode === "native" ? "fit" : "native"; renderViewer(); }
  else if (act === "tag")        { if (viewerMode) closeViewer(); setTag(btn.dataset.tag === activeTag ? null : btn.dataset.tag); }
  else if (act === "open") {
    slideIndex = Number(btn.dataset.index) || 0;
    activeView = "slideshow";
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

function attachSwipe(el, enabled) {
  let x0 = null, y0 = null;
  el.addEventListener("touchstart", e => {
    if (e.touches.length !== 1 || !enabled(e)) { x0 = null; return; }
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
  }, { passive: true });
  el.addEventListener("touchend", e => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  }, { passive: true });
}

function initInput() {
  const wrapper = document.getElementById("gallery-wrapper");
  wrapper.addEventListener("click", e => {
    const btn = e.target.closest("[data-act]");
    if (btn && !btn.disabled) handleAction(btn);
  });
  attachSwipe(wrapper, e => !!e.target.closest("#slide-stage"));

  const viewer = document.getElementById("viewer");
  viewer.addEventListener("click", e => {
    const btn = e.target.closest("[data-act]");
    if (btn && !btn.disabled) { handleAction(btn); return; }
    if (e.target.id === "viewer-img") {         // click the photo to zoom in / out
      viewerMode = viewerMode === "native" ? "fit" : "native";
      renderViewer();
    }
  });
  attachSwipe(document.getElementById("viewer-scroll"), () => viewerMode === "fit");

  document.getElementById("view-buttons").addEventListener("click", e => {
    const btn = e.target.closest(".view-btn");
    if (btn) setView(btn.dataset.view);
  });
  document.getElementById("filter-buttons").addEventListener("click", e => {
    const btn = e.target.closest(".filter-btn");
    if (btn) setTag(btn.dataset.tag || null);
  });
  document.getElementById("sort-btn").addEventListener("click", () => {
    const current = viewPhotos[slideIndex];
    newestFirst = !newestFirst;
    sortPhotos();
    applyFilter();
    slideIndex = Math.max(0, viewPhotos.indexOf(current));
    render();
  });
  document.getElementById("refresh-btn").addEventListener("click", () => loadGallery(true));

  document.addEventListener("keydown", e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest && e.target.closest("input, textarea, select")) return;
    if (!viewerMode && activeView !== "slideshow") return;
    if (!viewPhotos.length) return;
    if (e.key === "ArrowLeft")       { step(-1); e.preventDefault(); }
    else if (e.key === "ArrowRight") { step(1);  e.preventDefault(); }
    else if (e.key === "Escape" && viewerMode) closeViewer();
  });

  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
}

/* ============================================================
   LOAD
   ============================================================ */

async function loadGallery(force = false) {
  if (isLoading) return;
  isLoading = true;
  stopPlay();
  const refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) refreshBtn.disabled = true;

  const keepPath = pendingHash ? pendingHash.photo : (viewPhotos[slideIndex] || {}).path;
  showLoadingState("Listing photos…");
  renderStatsBar();

  try {
    listingInfo = await fetchListing(force);
    const photos = buildPhotos(listingInfo.entries);
    if (photos.length) updateProgress(0, photos.length);
    await loadMetadata(photos, updateProgress);

    allPhotos = photos;
    sortPhotos();
    buildTagIndex();

    if (pendingHash) {
      if (VIEWS.includes(pendingHash.view)) activeView = pendingHash.view;
      if (pendingHash.tag) activeTag = tagKey(pendingHash.tag);
      pendingHash = null;
    }
    applyFilter();
    const idx = keepPath ? viewPhotos.findIndex(p => p.path === keepPath) : -1;
    slideIndex = idx >= 0 ? idx : 0;

    isLoading = false;
    render();
  } catch (err) {
    isLoading = false;
    showLoadError(`Could not load photos: ${err.message}`);
    renderStatsBar();
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

/* ============================================================
   INIT
   ============================================================ */

document.addEventListener("DOMContentLoaded", () => {
  renderHeader();
  pendingHash = readHash();
  if (VIEWS.includes(pendingHash.view)) activeView = pendingHash.view;
  renderViewButtons();
  initInput();
  loadGallery();
});
