/**
 * Gallery — Gallery_script.js
 *
 * Builds the gallery entirely from the photo folder in the repo, so adding
 * photos only needs a push — no code changes.
 *
 * Features:
 *  - Folder listing via the GitHub API (one request, cached in localStorage)
 *  - Subfolders are albums; the folder name is a tag on every photo inside
 *  - One optional gallery.json for titles, captions, tags and dates
 *  - Photo date read from EXIF metadata (JPEG, PNG, WebP), cached per file
 *  - Views: Slideshow (default), Thumbnails grid, chronological Feed
 *  - Thumbnails show small copies made one at a time by a worker
 *    (Gallery_thumbs.js) and kept in Cache Storage, so phones never hold
 *    every full-size photo at once
 *  - Album / tag filters shared by every view
 *  - Expanded view (photo fitted to most of the screen) and Full Screen
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
  captionsFile: "gallery.json",
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
const VIEWS               = ["slideshow", "thumbnails", "feed"];
const THUMB_HEIGHT        = 512;               // px; sharp in a 3x phone tile, even for portrait photos
const THUMB_CACHE         = "Gallery_thumbs";  // Cache Storage name for the small copies
const THUMB_WORKER        = "Gallery_utils/Gallery_thumbs.js";

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
let viewerMode   = null;  // null (closed) | "expanded" | "full"
let fullClosesViewer = false; // viewer was opened straight into full screen
let listingInfo  = null;  // { savedAt, fromCache, stale, error }
let pendingHash  = null;  // hash state to apply once photos load
let loadNotices  = [];    // problems with the captions file
let clockTimer   = null;
const loadedSrcs = new Set(); // photo URLs already downloaded on this visit
const thumbUrls  = new Map(); // photo SHA (or path) → object URL of its small copy
let thumbWorker  = null;      // null = not started yet, false = unavailable
const thumbJobs  = new Map(); // worker job id → { resolve, reject }
let thumbJobId   = 0;
let thumbCache   = null;      // Promise of the Cache Storage cache (or null)
let thumbObserver = null;     // starts tiles as they near the screen
let thumbQueue   = [];        // grid images waiting for their small copy
let thumbBusy    = false;

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

/** Where a photo is displayed from — the copy next to this page. */
function photoUrl(path) {
  return `${encodePath(CFG.imagesDir)}/${encodePath(path)}`;
}

/** The same file on GitHub, used when the local copy can't be read. */
function remoteUrl(path) {
  return `https://raw.githubusercontent.com/${encodeURIComponent(CFG.owner)}/${encodeURIComponent(CFG.repo)}/` +
         `${encodePath(CFG.branch)}/${encodePath(CFG.imagesDir)}/${encodePath(path)}`;
}

function isFilePage() {
  return location.protocol === "file:";
}

/**
 * Where file contents (gallery.json, photo dates) are read from. A page
 * opened from disk can display local images but the browser won't let it
 * read local files, so it reads them from GitHub instead.
 */
function dataUrl(path) {
  return isFilePage() ? remoteUrl(path) : photoUrl(path);
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
  if (!photo.date) return "";
  const opts = { weekday: "short", month: "short", day: "numeric", year: "numeric" };
  if (photo.hasTime) Object.assign(opts, { hour: "numeric", minute: "2-digit" });
  return dateParts(photo.date).toLocaleString("en-US", opts);
}

function monthLabel(photo) {
  if (!photo.date) return "";
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
  // Ask for just the first bytes from this site; other hosts would need a
  // CORS preflight for the Range header, so stream and stop early instead.
  const sameOrigin = new URL(url, location.href).origin === location.origin;
  const res = await fetch(url, sameOrigin ? { headers: { Range: `bytes=0-${maxBytes - 1}` } } : {});
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
  const url = dataUrl(photo.path);
  let found = exifDateFromBuffer(await fetchHead(url, EXIF_HEAD_BYTES));
  const size = photo.size;                            // null when served from a local folder
  if (found === undefined && (size === null || (size > EXIF_HEAD_BYTES && size <= FULL_SCAN_MAX_BYTES))) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    found = exifDateFromBuffer(await res.arrayBuffer());
  }
  return found || null;
}

/* ============================================================
   CAPTIONS FILE — one JSON file for the whole gallery
   (Gallery_images/gallery.json), keyed by photo path:
   {
     "sunset.jpg": {
       "title":   "Optional headline",
       "caption": "Free text. Use \n for a line break.",
       "tags":    ["NYC", "Sunset"],
       "date":    "2024-05-12 18:42"      (optional; overrides metadata)
     },
     "Iceland 2025/glacier.jpg": { "caption": "…" }
   }
   Keys match the path inside the photo folder; a bare file name also
   works when it is unique. Matching ignores upper/lower case.
   ============================================================ */

function toText(value) {
  if (Array.isArray(value)) return value.map(toText).join("\n");
  return value === null || value === undefined ? "" : String(value).trim();
}

function normalizeCaptionEntry(raw) {
  if (typeof raw === "string") raw = { caption: raw };
  if (!raw || typeof raw !== "object") return null;
  const tags = Array.isArray(raw.tags) ? raw.tags : String(raw.tags || "").split(/[,;]/);
  return {
    title:   toText(raw.title),
    caption: toText(raw.caption),
    tags:    tags.map(t => toText(t).replace(/^#/, "")).filter(Boolean),
    date:    raw.date ? parseLooseDate(String(raw.date)) : null,
  };
}

/** Parse gallery.json into a map of lower-cased key → entry, plus any problems. */
function parseCaptions(text) {
  let data;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch (err) {
    return { map: new Map(), error: `${CFG.captionsFile} has a formatting error (${err.message}) — captions and tags are not shown` };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { map: new Map(), error: `${CFG.captionsFile} must be a { "photo.jpg": { … } } object` };
  }
  const map = new Map();
  for (const [key, raw] of Object.entries(data)) {
    const entry = normalizeCaptionEntry(raw);
    if (entry) map.set(key.trim().replace(/^\/+/, "").toLowerCase(), entry);
  }
  return { map, error: null };
}

async function loadCaptions(fileEntry, cache, keep) {
  if (!fileEntry) return { map: new Map(), error: null };
  const key = fileEntry.sha ? "j:" + fileEntry.sha : null;
  let text = key && typeof cache[key] === "string" ? cache[key] : null;
  if (text === null) {
    try {
      const res = await fetch(dataUrl(fileEntry.path), { cache: "no-store" });
      if (res.ok) text = await res.text();
    } catch {}
  }
  if (text === null) return { map: new Map(), error: `Could not read ${CFG.captionsFile} — try Refresh in a minute` };
  if (key) keep[key] = text;
  return parseCaptions(text);
}

/** Warn about entries that match no photo, so typos in file names are visible. */
function unmatchedCaptionKeys(map, photos) {
  const paths = new Set(photos.map(p => p.path.toLowerCase()));
  const names = new Set(photos.map(p => p.name.toLowerCase()));
  return [...map.keys()].filter(k => !paths.has(k) && !names.has(k));
}

/* ============================================================
   LISTING + CACHING (localStorage)
   On GitHub Pages the photo list comes from the GitHub API (the branch in
   CFG). When previewing a copy of the repo on a local web server, the
   server's own folder listing is used instead, so local photos show up
   before they are pushed.
   ============================================================ */

function isGithubPages() {
  return /\.github\.io$/i.test(location.hostname);
}

function githubLocation() {
  return `${CFG.imagesDir}/ on the ${CFG.branch} branch of ${CFG.owner}/${CFG.repo}`;
}

/** Walk a web server's auto-generated folder listing (e.g. python -m http.server). */
async function fetchServerListing() {
  const base    = new URL(encodePath(CFG.imagesDir) + "/", location.href);
  const entries = new Map();
  const visited = new Set();

  const crawl = async (dirUrl, depth) => {
    if (depth > 6 || visited.has(dirUrl.pathname)) return;
    visited.add(dirUrl.pathname);
    const res = await fetch(dirUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!(res.headers.get("content-type") || "").includes("html")) throw new Error("no folder listing");
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    for (const a of doc.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href");
      if (!href || /^[?#]/.test(href)) continue;
      const url = new URL(href, dirUrl);
      url.search = "";
      url.hash = "";
      // Only follow links that lead deeper into this folder.
      if (url.origin !== base.origin || !url.pathname.startsWith(dirUrl.pathname) || url.pathname === dirUrl.pathname) continue;
      if (url.pathname.endsWith("/")) {
        await crawl(url, depth + 1);
      } else {
        const path = decodeURIComponent(url.pathname.slice(base.pathname.length));
        entries.set(path, { path, sha: null, size: null });
      }
    }
  };

  await crawl(base, 0);
  return [...entries.values()];
}

function treeCacheId() {
  return [CFG.owner, CFG.repo, CFG.branch, CFG.imagesDir].join("|").toLowerCase();
}

async function fetchListing(force) {
  // A local web server's folder listing shows photos before they're pushed.
  // Pages opened from disk (file://) and GitHub Pages use the GitHub listing.
  if (!isGithubPages() && !isFilePage()) {
    try {
      const entries = await fetchServerListing();
      return { entries, savedAt: Date.now(), fromCache: false, source: "local" };
    } catch {
      // No folder listing on this host — fall through to the GitHub API.
    }
  }

  const cached = readJSON(TREE_CACHE_KEY);
  const usable = cached && cached.id === treeCacheId() && Array.isArray(cached.entries);
  const ttlMs  = CFG.cacheTTLMinutes * 60 * 1000;
  if (usable && !force && Date.now() - cached.savedAt < ttlMs) {
    return { entries: cached.entries, savedAt: cached.savedAt, fromCache: true, source: "github" };
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
    return { entries, savedAt, fromCache: false, source: "github" };
  } catch (err) {
    if (usable) {
      return { entries: cached.entries, savedAt: cached.savedAt, fromCache: true, stale: true, error: err.message, source: "github" };
    }
    throw err;
  }
}

function buildPhotos(entries) {
  const captionsName = CFG.captionsFile.toLowerCase();
  let captionsEntry = null;
  const images = [];
  for (const e of entries) {
    if (e.path.toLowerCase() === captionsName) { captionsEntry = e; continue; }
    const parts = e.path.split("/");
    // Skip hidden files and anything GitHub Pages (Jekyll) won't publish.
    if (parts.some(p => /^[._#~]/.test(p))) continue;
    if (IMAGE_EXTS.has(extOf(e.path))) images.push(e);
  }

  const photos = images.map(e => {
    const folders = e.path.split("/");
    const name    = folders.pop();
    return {
      path: e.path,
      name,
      sha: e.sha,
      size: e.size,
      folders,
      title: "",
      caption: "",
      tags: [],
      date: null,
      hasTime: false,
    };
  });
  return { photos, captionsEntry };
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
 * Fill in captions and EXIF dates. The captions file and each photo's date
 * are cached by git blob SHA, so a file is only re-read after it changes.
 * Failures (e.g. a photo pushed moments ago that Pages hasn't published
 * yet) are not cached. Returns any problems to show above the photos.
 */
async function loadMetadata(photos, captionsEntry, onProgress) {
  const cache = readJSON(META_CACHE_KEY) || {};
  const keep  = {};
  const notices = [];
  let done = 0;

  const captions = await loadCaptions(captionsEntry, cache, keep);
  if (captions.error) notices.push(captions.error);
  const unmatched = unmatchedCaptionKeys(captions.map, photos);
  if (unmatched.length) {
    notices.push(`${CFG.captionsFile}: no photo named ${unmatched.map(k => `“${k}”`).join(", ")}`);
  }

  const tasks = photos.map(photo => async () => {
    const info = captions.map.get(photo.path.toLowerCase()) || captions.map.get(photo.name.toLowerCase()) || null;

    const exifKey = photo.sha ? "x:" + photo.sha : null;
    let exif = exifKey ? cache[exifKey] : undefined;
    if (exif === undefined && !(info && info.date)) {
      try {
        const found = await readExifDate(photo);
        exif = found ? { d: found.iso, t: found.hasTime } : { d: null };
      } catch {
        exif = undefined;
      }
    }
    if (exifKey && exif !== undefined) keep[exifKey] = exif;

    const exifDate = exif && exif.d ? { iso: exif.d, hasTime: exif.t !== false } : null;
    const date = (info && info.date) || exifDate || dateFromFilename(photo.name);
    photo.date    = date ? date.iso : null;
    photo.hasTime = date ? date.hasTime : false;

    photo.title   = info ? info.title : "";
    photo.caption = info ? info.caption : "";
    const seen = new Set();
    photo.tags = [];
    for (const [label, album] of [
      ...photo.folders.map(f => [f, true]),
      ...(info ? info.tags : []).map(t => [t, false]),
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
  return notices;
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
  const titleEl = document.getElementById("header-title");
  if (titleEl) titleEl.innerHTML = '<a href="index.html" style="color:inherit;text-decoration:none;">' + escHtml(CFG.title) + '</a>';
  document.title = CFG.title;
  renderClock();
}

/** Header date and time, redrawn at the start of every minute. */
function renderClock() {
  const now     = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric" });
  const timeStr = now.toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit" });

  const dateEl = document.getElementById("header-date");
  if (dateEl) dateEl.textContent = dateStr.toUpperCase();

  const timeEl = document.getElementById("header-time");
  if (timeEl) timeEl.textContent = timeStr;

  clearTimeout(clockTimer);
  clockTimer = setTimeout(renderClock, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()));
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
  return `<button class="filter-btn${active ? " active" : ""}" data-tag="${entry ? escHtml(entry.key) : ""}">${label}</button>`;
}

/** "All", then albums, then tags — same button row as the briefs. */
function renderFilters() {
  const wrap = document.getElementById("filter-buttons");
  if (!wrap) return;
  const byLabel = (a, b) => a.label.localeCompare(b.label, undefined, { numeric: true });
  const entries = [...tagIndex.values()];
  if (!entries.length) { wrap.innerHTML = ""; return; }
  const ordered = [
    ...entries.filter(t => t.album).sort(byLabel),
    ...entries.filter(t => !t.album).sort(byLabel),
  ];
  wrap.innerHTML = filterButton(null) + ordered.map(filterButton).join("");
}

function renderLastUpdated() {
  const el = document.getElementById("last-updated");
  if (!el) return;
  if (!listingInfo) { el.textContent = ""; return; }
  const label = listingInfo.source === "local" ? "Local folder" : listingInfo.fromCache ? "Cached" : "Live";
  el.textContent = `${label} · ${relativeTime(listingInfo.savedAt)}`;
}

/* ============================================================
   RENDER — shared photo details
   ============================================================ */

function tagChipsHtml(photo) {
  return photo.tags
    .map(t => `<span class="${t.album ? "card-source" : "card-category"}">${escHtml(t.label)}</span>`)
    .join("");
}

/* Each field renders only when the photo has it — no placeholders. */

function detailsHtml(photo) {
  const date = formatPhotoDate(photo);
  const tags = tagChipsHtml(photo);
  return (date ? `<div class="card-time">${escHtml(date)}</div>` : "") +
         (tags ? `<div class="card-meta">${tags}</div>` : "");
}

function captionHtml(photo) {
  return (photo.title   ? `<div class="card-title">${escHtml(photo.title)}</div>` : "") +
         (photo.caption ? `<div class="card-preview">${escHtml(photo.caption)}</div>` : "");
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
      <img src="${escHtml(photoUrl(photo.path))}" data-path="${escHtml(photo.path)}" alt="${escHtml(altText(photo))}" decoding="async">
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
    img.onload = () => loadedSrcs.add(img.src);
    img.src = photoUrl(viewPhotos[(slideIndex + d + n) % n].path);
  }
}

/* ============================================================
   RENDER — thumbnails (same month headings as the feed)
   ============================================================ */

function renderThumbnails() {
  const wrapper = document.getElementById("gallery-wrapper");
  if (!wrapper) return;
  if (!viewPhotos.length) { wrapper.innerHTML = noticeHtml() + emptyHtml(); return; }

  const groups = [];
  viewPhotos.forEach((photo, i) => {
    const month = monthLabel(photo);
    if (!groups.length || groups[groups.length - 1].month !== month) groups.push({ month, tiles: [] });
    // Tiles start empty and get their small copy from watchThumbs, unless
    // it was already made on this visit.
    const ready = thumbUrls.get(thumbKey(photo));
    groups[groups.length - 1].tiles.push(`
  <button class="thumb" data-act="open" data-index="${i}">
    <img${ready ? ` src="${escHtml(ready)}"` : ""} data-path="${escHtml(photo.path)}" alt="${escHtml(altText(photo))}" loading="lazy" decoding="async">
  </button>`);
  });

  const parts = [noticeHtml()];
  groups.forEach((group, gi) => {
    // Undated photos get no heading, just the same gap a heading leaves.
    if (group.month) parts.push(`<div class="feed-month">${escHtml(group.month)}</div>`);
    const gap = !group.month && gi > 0 ? " feed-card-gap" : "";
    parts.push(`<div class="thumb-grid${gap}">${group.tiles.join("")}</div>`);
  });
  wrapper.innerHTML = parts.join("");
  watchThumbs();
}

function focusCurrentThumb() {
  const thumb = document.querySelector(`.thumb[data-index="${slideIndex}"]`);
  if (thumb) thumb.focus();
}

/* ============================================================
   THUMBNAILS — small copies for the grid
   A grid of full-size photos is more than a phone can hold in memory
   (Safari reloads the page, then gives up with "A problem repeatedly
   occurred"). So each tile gets a small JPEG instead, made by a worker one
   photo at a time as tiles near the screen. Copies are kept for the visit
   and in Cache Storage by git blob SHA, so a photo is only shrunk again
   after it changes. Without a worker (a page opened from disk, or a very
   old browser) the tiles show the photos themselves.
   ============================================================ */

function thumbKey(photo) {
  return photo.sha || photo.path;
}

/** Cache Storage key for a photo's small copy; only photos with a SHA are stored. */
function thumbCacheUrl(photo) {
  if (!photo.sha) return null;
  return new URL(`${photoUrl(photo.path)}?thumb=${photo.sha}&h=${THUMB_HEIGHT}`, location.href).href;
}

function openThumbCache() {
  if (!thumbCache) {
    thumbCache = (window.caches ? caches.open(THUMB_CACHE) : Promise.resolve(null)).catch(() => null);
  }
  return thumbCache;
}

async function readStoredThumb(photo) {
  const key   = thumbCacheUrl(photo);
  const cache = key && await openThumbCache();
  if (!cache) return null;
  try {
    const res = await cache.match(key);
    return res ? await res.blob() : null;
  } catch { return null; }
}

async function storeThumb(photo, blob) {
  const key   = thumbCacheUrl(photo);
  const cache = key && await openThumbCache();
  if (!cache) return;
  try { await cache.put(key, new Response(blob, { headers: { "Content-Type": "image/jpeg" } })); } catch {}
}

/** Drop stored copies of photos that have since changed or been removed. */
async function pruneStoredThumbs(photos) {
  const cache = await openThumbCache();
  if (!cache) return;
  const keep = new Set(photos.map(thumbCacheUrl));
  try {
    for (const req of await cache.keys()) {
      if (!keep.has(req.url)) await cache.delete(req);
    }
  } catch {}
}

/** Pages opened from disk can't start workers, and very old browsers lack the APIs. */
function canShrinkPhotos() {
  return thumbWorker !== false && !isFilePage() &&
         !!(window.Worker && window.OffscreenCanvas && window.createImageBitmap);
}

/** The worker, started on first use. */
function getThumbWorker() {
  if (thumbWorker !== null || !canShrinkPhotos()) return thumbWorker;
  try {
    const worker = new Worker(THUMB_WORKER);
    worker.onmessage = e => {
      const job = thumbJobs.get(e.data.id);
      if (!job) return;
      thumbJobs.delete(e.data.id);
      if (e.data.blob) job.resolve(e.data.blob);
      else job.reject(new Error(e.data.error));
    };
    worker.onerror = () => {                   // the worker script didn't load
      thumbWorker = false;
      for (const job of thumbJobs.values()) job.reject(new Error("thumbnail worker failed"));
      thumbJobs.clear();
    };
    thumbWorker = worker;
  } catch {
    thumbWorker = false;
  }
  return thumbWorker;
}

function shrinkPhoto(photo) {
  const worker = getThumbWorker();
  if (!worker) return Promise.reject(new Error("no thumbnail worker"));
  return new Promise((resolve, reject) => {
    const id = ++thumbJobId;
    thumbJobs.set(id, { resolve, reject });
    worker.postMessage({ id, url: new URL(photoUrl(photo.path), location.href).href, height: THUMB_HEIGHT });
  });
}

async function thumbUrlFor(photo) {
  const key = thumbKey(photo);
  if (thumbUrls.has(key)) return thumbUrls.get(key);
  let blob = await readStoredThumb(photo);
  if (!blob) {
    blob = await shrinkPhoto(photo);
    storeThumb(photo, blob);
  }
  const url = URL.createObjectURL(blob);
  thumbUrls.set(key, url);
  return url;
}

/** Give the grid's empty tiles their small copies as they come near the screen. */
function watchThumbs() {
  const imgs = [...document.querySelectorAll(".thumb img:not([src])")];
  if (!imgs.length) return;
  if (!canShrinkPhotos()) {
    imgs.forEach(img => { img.src = photoUrl(img.dataset.path); });
    return;
  }
  if (!window.IntersectionObserver) {
    thumbQueue.push(...imgs);
    pumpThumbs();
    return;
  }
  thumbObserver = new IntersectionObserver((entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      thumbQueue.push(entry.target);
    }
    pumpThumbs();
  }, { rootMargin: "100% 0px" });
  imgs.forEach(img => thumbObserver.observe(img));
}

function stopThumbs() {
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = null;
  thumbQueue = [];
}

/** One photo at a time, so only one full-size photo is decoded at once. */
async function pumpThumbs() {
  if (thumbBusy) return;
  thumbBusy = true;
  while (thumbQueue.length) {
    const img = thumbQueue.shift();
    if (!img.isConnected || img.hasAttribute("src")) continue;
    const photo = viewPhotos.find(p => p.path === img.dataset.path);
    if (!photo) continue;
    let url;
    try {
      url = await thumbUrlFor(photo);
    } catch {
      url = photoUrl(photo.path);             // couldn't shrink it — show the photo itself
    }
    if (img.isConnected) img.src = url;
  }
  thumbBusy = false;
  // Nothing left to shrink: free the worker's memory until more tiles need it.
  if (thumbWorker) {
    thumbWorker.terminate();
    thumbWorker = null;
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
    let gap = "";
    if (month !== lastMonth) {
      // Undated photos get no heading, just the same gap a heading leaves.
      if (month) parts.push(`<div class="feed-month">${escHtml(month)}</div>`);
      else if (lastMonth) gap = " feed-card-gap";
      lastMonth = month;
    }
    parts.push(`
<div class="article-card feed-card${gap}">
  <div class="card-accent ${colorForIndex(i)}"></div>
  <div class="card-body">
    ${detailsHtml(photo)}
    <div class="feed-image">
      <img src="${escHtml(photoUrl(photo.path))}" data-path="${escHtml(photo.path)}" alt="${escHtml(altText(photo))}" loading="lazy" decoding="async">
    </div>
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
  const notices = loadNotices.slice();
  if (listingInfo && listingInfo.stale) notices.unshift(`Showing saved listing · ${listingInfo.error || "GitHub unavailable"}`);
  return notices.map(n => `<div class="notice-card">⚠ ${escHtml(n)}</div>`).join("");
}

function emptyHtml() {
  if (activeTag) return `<div class="empty-state">No photos tagged “${escHtml(tagIndex.get(activeTag)?.label || activeTag)}”</div>`;
  const where = listingInfo && listingInfo.source === "local"
    ? `Looked in ${CFG.imagesDir}/ on this server.`
    : `Looked in ${githubLocation()}. Photos appear here once they are pushed to that branch — use ↻ Refresh after pushing.`;
  return `<div class="empty-state">No photos found<div class="empty-detail">${escHtml(where)}</div></div>`;
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
  stopThumbs();
  if (activeView === "feed") renderFeed();
  else if (activeView === "thumbnails") renderThumbnails();
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
   VIEWER — Expanded (photo fitted to most of the screen) + Full Screen
   ============================================================ */

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function enterFullscreen(el) {
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req) return;
  try {
    const p = req.call(el);
    if (p && p.catch) p.catch(() => {});      // refused: the viewer still fills the window
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

function openViewer(mode) {
  if (!viewPhotos.length) return;
  const viewer = document.getElementById("viewer");
  viewerMode = mode;
  fullClosesViewer = mode === "full";
  viewer.classList.add("open");
  document.body.classList.add("viewer-open");
  if (mode === "full") enterFullscreen(viewer);
  renderViewer();
  const closeBtn = viewer.querySelector('[data-act="close"]');
  if (closeBtn) closeBtn.focus({ preventScroll: true });
}

function closeViewer() {
  if (!viewerMode) return;
  const viewer = document.getElementById("viewer");
  viewerMode = null;
  fullClosesViewer = false;
  exitFullscreen();
  viewer.classList.remove("open", "mode-full");
  document.body.classList.remove("viewer-open");
  const img = document.getElementById("viewer-img");
  img.removeAttribute("src");
  delete img.dataset.path;
  setViewerStatus("");
  if (activeView === "slideshow") {
    renderSlideshow();
  } else {
    stopPlay();                                // nothing left on screen to advance
    if (activeView === "thumbnails") focusCurrentThumb();
  }
  writeHash();
}

/** Switch between the expanded view and full screen without closing. */
function setViewerFull(full) {
  if (full) {
    viewerMode = "full";
    enterFullscreen(document.getElementById("viewer"));
  } else {
    viewerMode = "expanded";
    fullClosesViewer = false;                  // leaving by button keeps the viewer open
    exitFullscreen();
  }
  renderViewerChrome();
}

/** Esc: full screen goes back to where it was opened from; otherwise close. */
function leaveViewer() {
  if (viewerMode === "full" && !fullClosesViewer) setViewerFull(false);
  else closeViewer();
}

function renderViewerChrome() {
  const viewer = document.getElementById("viewer");
  viewer.classList.toggle("mode-full", viewerMode === "full");

  const fsBtn = document.getElementById("viewer-fs");
  if (fsBtn) fsBtn.textContent = viewerMode === "full" ? "Exit Full Screen" : "Full Screen";

  viewer.querySelectorAll('[data-act="prev"], [data-act="next"], [data-act="play"]').forEach(b => {
    b.disabled = viewPhotos.length < 2;
  });
  syncPlayButtons();
}

function renderViewer() {
  const n = viewPhotos.length;
  if (!n || !viewerMode) return;
  slideIndex = ((slideIndex % n) + n) % n;
  const photo = viewPhotos[slideIndex];
  const img   = document.getElementById("viewer-img");

  renderViewerChrome();
  document.getElementById("viewer-count").textContent = `${slideIndex + 1} / ${n}`;

  if (img.dataset.path !== photo.path) {
    const path = photo.path;
    let retried = false;
    img.dataset.path = path;
    delete img.dataset.remote;
    img.onload = () => {
      if (img.dataset.path === path) setViewerStatus("");
    };
    img.onerror = () => {
      if (img.dataset.path !== path) return;
      // Opened from disk, the error handler in initInput has just retried
      // the photo from GitHub — keep waiting for that copy.
      if (img.dataset.remote && !retried) { retried = true; return; }
      setViewerStatus("failed");
    };
    img.src = photoUrl(path);
    // A photo already downloaded (preloaded, or seen in another view) shows
    // at once, with no spinner.
    setViewerStatus(img.complete || loadedSrcs.has(img.src) ? "" : "loading");
  }
  img.alt = altText(photo);

  const caption = document.getElementById("viewer-caption");
  caption.innerHTML = detailsHtml(photo) + captionHtml(photo);   // empty → bar hidden
  preloadNeighbors();
}

/** Hide the previous photo while the next one loads, and say if it can't. */
function setViewerStatus(state) {
  const stage  = document.getElementById("viewer-stage");
  const status = document.getElementById("viewer-status");
  stage.classList.toggle("is-loading", state === "loading");
  stage.classList.toggle("is-failed", state === "failed");
  status.innerHTML =
    state === "loading" ? `<div class="viewer-spinner"></div><span>Loading photo…</span>` :
    state === "failed"  ? `<span>⚠ This photo could not be loaded</span>` : "";
}

function onFullscreenChange() {
  // The browser left full screen (Esc or its own control).
  if (viewerMode !== "full" || fullscreenElement()) return;
  leaveViewer();
}

/* ============================================================
   INPUT — clicks, keys, swipes
   ============================================================ */

function handleAction(btn) {
  const act = btn.dataset.act;
  if (act === "prev")            step(-1);
  else if (act === "next")       step(1);
  else if (act === "play")       playTimer ? stopPlay() : startPlay();
  else if (act === "expand")     openViewer("expanded");
  else if (act === "open")       { slideIndex = +btn.dataset.index; openViewer("expanded"); }
  else if (act === "fullscreen") viewerMode ? setViewerFull(viewerMode !== "full") : openViewer("full");
  else if (act === "close")      closeViewer();
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
    if (e.target === viewer) { closeViewer(); return; }   // the dimmed area around the expanded view
    const btn = e.target.closest("[data-act]");
    if (btn && !btn.disabled) handleAction(btn);
  });
  attachSwipe(document.getElementById("viewer-stage"), () => !!viewerMode);

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
    else if (e.key === "Escape" && viewerMode) leaveViewer();
  });

  document.addEventListener("load", e => {
    if (e.target instanceof HTMLImageElement && e.target.dataset.path) loadedSrcs.add(e.target.src);
  }, true);

  // Opened from disk: a listed photo missing from this copy is shown from GitHub.
  document.addEventListener("error", e => {
    const img = e.target;
    if (!isFilePage() || !(img instanceof HTMLImageElement) || !img.dataset.path || img.dataset.remote) return;
    img.dataset.remote = "1";
    img.src = remoteUrl(img.dataset.path);
  }, true);

  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);

  // Background tabs run timers late; catch the clock up on return.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) renderClock(); });
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
    const { photos, captionsEntry } = buildPhotos(listingInfo.entries);
    if (photos.length) updateProgress(0, photos.length);
    loadNotices = await loadMetadata(photos, captionsEntry, updateProgress);

    allPhotos = photos;
    sortPhotos();
    buildTagIndex();
    if (listingInfo.source === "github") pruneStoredThumbs(allPhotos);

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
