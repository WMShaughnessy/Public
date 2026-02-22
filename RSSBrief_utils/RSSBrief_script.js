/**
 * RSS Brief — RSSBrief_script.js
 *
 * Fetches RSS feeds client-side via rss2json API (CORS bridge),
 * with corsproxy.io fallback.
 *
 * Features:
 *  - localStorage caching with configurable TTL (default 15 min)
 *  - Collapsible source list grouped by category, clickable to filter
 *  - Source filter draws up to 15 most recent articles from raw feed cache
 *  - Feed failure indicators per source
 *  - Title-based deduplication across sources
 *  - Category filter buttons (Government + Legal merged)
 *  - Card accent color driven by article category
 *  - Meta/cache status inline in stats bar
 *  - Live refresh
 */

/* ============================================================
   CONFIG
   ============================================================ */

const DEFAULT_CONFIG = {
  title: "RSS Brief",
  totalArticles: 30,
  maxPerSource: 5,
  cacheTTLMinutes: 15,
  dedupThreshold: 0.72,
  rss2jsonApiKey: null,
  sources: [],
};

const CFG = Object.assign({}, DEFAULT_CONFIG, window.BRIEF_CONFIG || {});
const CACHE_PREFIX   = "RSSBrief_feed_";
const CACHE_META_KEY = "RSSBrief_meta";

// Categories that share the "Gov & Legal" combined filter button
const GOV_LEGAL_CATS = new Set(["Government", "Legal"]);

/* ============================================================
   STATE
   ============================================================ */

let allArticles      = [];   // deduped, capped — the main feed
let rawBySource      = {};   // sourceName → all fetched articles (pre-dedup, pre-cap)
let activeCategory   = null; // null = all; "Gov & Legal" = combined; or any single category
let activeSource     = null; // source name string or null
let isLoading        = false;
let feedStatuses     = [];   // [{ name, category, ok, count, error, fromCache }]
let sourcesOpen      = false;

/* ============================================================
   HELPERS
   ============================================================ */

function escHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function relativeTime(isoStr) {
  if (!isoStr) return "";
  try {
    const dt = new Date(isoStr);
    const s = Math.floor((Date.now() - dt.getTime()) / 1000);
    if (s < 0)     return "just now";
    if (s < 60)    return `${s}s ago`;
    if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  } catch { return ""; }
}

function formatDate(isoStr) {
  if (!isoStr) return "";
  try {
    const dt = new Date(isoStr);
    const formatted = dt.toLocaleString("en-US", {
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit"
    });
    const rel = relativeTime(isoStr);
    return rel ? `${formatted} (${rel})` : formatted;
  } catch { return isoStr; }
}

const COLORS = ["red", "yellow", "blue"];

function colorForIndex(i) {
  return COLORS[i % COLORS.length];
}

function categoryClass(cat) {
  if (!cat) return "";
  return "cat-" + cat.toLowerCase().replace(/\s+/g, "-");
}

/**
 * Return the display categories for filter buttons.
 * Government and Legal are collapsed into one "Gov & Legal" entry.
 */
function displayCategories(articles) {
  const seen = new Set();
  const cats = [];
  for (const a of articles) {
    const cat = a.category;
    if (!cat) continue;
    // Both Government and Legal map to "Gov & Legal"
    const display = GOV_LEGAL_CATS.has(cat) ? "Gov & Legal" : cat;
    if (!seen.has(display)) {
      seen.add(display);
      cats.push(display);
    }
  }
  return cats.sort();
}

/* ============================================================
   CACHING  (localStorage)
   ============================================================ */

function cacheKey(sourceUrl) {
  return CACHE_PREFIX + btoa(sourceUrl).replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);
}

function readCache(sourceUrl) {
  try {
    const raw = localStorage.getItem(cacheKey(sourceUrl));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    const ageMs = Date.now() - entry.savedAt;
    if (ageMs > CFG.cacheTTLMinutes * 60 * 1000) return null;
    return entry;
  } catch { return null; }
}

function writeCache(sourceUrl, articles) {
  try {
    localStorage.setItem(cacheKey(sourceUrl), JSON.stringify({
      savedAt: Date.now(),
      articles,
    }));
  } catch (e) {
    console.warn("[RSSBrief] Cache write failed:", e.message);
  }
}

function writeMeta(info) {
  try {
    localStorage.setItem(CACHE_META_KEY, JSON.stringify({ ...info, savedAt: Date.now() }));
  } catch {}
}

function readMeta() {
  try {
    const raw = localStorage.getItem(CACHE_META_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/* ============================================================
   DEDUPLICATION
   ============================================================ */

function normalizeTitle(title) {
  return (title || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSimilarity(a, b) {
  const wordsA = new Set(normalizeTitle(a).split(" ").filter(w => w.length > 2));
  const wordsB = new Set(normalizeTitle(b).split(" ").filter(w => w.length > 2));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) { if (wordsB.has(w)) intersection++; }
  return intersection / (wordsA.size + wordsB.size - intersection);
}

function deduplicateArticles(articles) {
  const kept = [];
  for (const candidate of articles) {
    let isDup = false;
    for (const existing of kept) {
      if (titleSimilarity(candidate.title, existing.title) >= CFG.dedupThreshold) {
        isDup = true;
        break;
      }
    }
    if (!isDup) kept.push(candidate);
  }
  return kept;
}

/* ============================================================
   FETCH  —  rss2json → corsproxy fallback
   ============================================================ */

async function fetchFeedViaRss2Json(source) {
  const params = new URLSearchParams({
    rss_url:   source.url,
    count:     String(Math.max(CFG.maxPerSource * 3, 15)),
    order_by:  "pubDate",
    order_dir: "desc",
  });
  if (CFG.rss2jsonApiKey) params.set("api_key", CFG.rss2jsonApiKey);

  const res = await fetch(`https://api.rss2json.com/v1/api.json?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  if (data.status !== "ok") throw new Error(data.message || "rss2json error");

  return (data.items || []).map(item => ({
    title:       item.title || "Untitled",
    link:        item.link  || item.guid || "",
    pubDate:     item.pubDate || null,
    description: item.description || item.content || "",
    source:      source.name,
    category:    source.category || "Uncategorized",
    sourceUrl:   source.url,
  }));
}

async function fetchFeedViaCorsProxy(source) {
  const res = await fetch("https://corsproxy.io/?" + encodeURIComponent(source.url));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const text   = await res.text();
  const parser = new DOMParser();
  const doc    = parser.parseFromString(text, "application/xml");
  const items  = Array.from(doc.querySelectorAll("item, entry"));

  return items.map(item => {
    const get = sel => {
      const el = item.querySelector(sel);
      return el ? (el.textContent || "") : "";
    };
    const linkEl  = item.querySelector("link");
    const link    = get("link") || linkEl?.getAttribute("href") || "";
    const pubDate = get("pubDate") || get("published") || get("updated") || null;

    return {
      title:       get("title") || "Untitled",
      link:        link.trim(),
      pubDate:     pubDate ? pubDate.trim() : null,
      description: get("description") || get("summary") || get("content") || "",
      source:      source.name,
      category:    source.category || "Uncategorized",
      sourceUrl:   source.url,
    };
  });
}

async function fetchFeed(source) {
  const cached = readCache(source.url);
  if (cached) {
    return { articles: cached.articles, fromCache: true, error: null };
  }
  try {
    const articles = await fetchFeedViaRss2Json(source);
    writeCache(source.url, articles);
    return { articles, fromCache: false, error: null };
  } catch (e1) {
    console.warn(`[RSSBrief] rss2json failed for "${source.name}": ${e1.message}`);
    try {
      const articles = await fetchFeedViaCorsProxy(source);
      writeCache(source.url, articles);
      return { articles, fromCache: false, error: null };
    } catch (e2) {
      console.error(`[RSSBrief] Both methods failed for "${source.name}": ${e2.message}`);
      return { articles: [], fromCache: false, error: e2.message };
    }
  }
}

/* ============================================================
   RENDER — header
   ============================================================ */

function renderHeader() {
  const now     = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric" });
  const timeStr = now.toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit" });

  const titleEl = document.getElementById("header-title");
  if (titleEl) titleEl.textContent = CFG.title;
  document.title = CFG.title;

  const dateEl = document.getElementById("header-date");
  if (dateEl) dateEl.textContent = dateStr.toUpperCase();

  const timeEl = document.getElementById("header-time");
  if (timeEl) timeEl.textContent = timeStr;
}

/* ============================================================
   RENDER — stats count
   ============================================================ */

function renderStatsBar(count) {
  const el = document.getElementById("stats-count-label");
  if (el) el.textContent = `${count} ARTICLE${count !== 1 ? "S" : ""}`;
}

/* ============================================================
   RENDER — inline meta
   ============================================================ */

function renderMetaInline(allFromCache) {
  const wrap = document.getElementById("meta-inline");
  if (!wrap) return;

  const dot  = wrap.querySelector(".cache-dot");
  const text = wrap.querySelector(".cache-text");
  const time = wrap.querySelector(".cache-time");

  if (dot)  dot.className      = "cache-dot " + (allFromCache ? "fresh" : "stale");
  if (text) text.textContent   = allFromCache ? "Cached" : "Live";

  const meta = readMeta();
  if (time && meta) {
    time.textContent = "· " + relativeTime(new Date(meta.savedAt).toISOString());
  }
}

/* ============================================================
   RENDER — sources panel (collapsible, grouped by category)
   ============================================================ */

function renderSourcesPanel(statuses) {
  const detail = document.getElementById("sources-detail");
  if (!detail) return;

  // Group by category
  const groups = {};
  for (const s of statuses) {
    const cat = s.category || "Uncategorized";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(s);
  }

  const html = Object.keys(groups).sort().map(cat => {
    const items = groups[cat].map(s => {
      const isActive   = activeSource === s.name;
      const statusCls  = s.error ? "src-fail" : (s.fromCache ? "src-cache" : "src-ok");
      const statusIcon = s.error ? "✗" : (s.fromCache ? "↩" : "✓");
      return `<div class="source-item ${isActive ? "active" : ""} ${statusCls}"
                   data-source="${escHtml(s.name)}">
        <span class="src-icon">${statusIcon}</span>
        <span class="src-name">${escHtml(s.name)}</span>
      </div>`;
    }).join("");

    return `<div class="source-group">
      <div class="source-group-label">${escHtml(cat)}</div>
      ${items}
    </div>`;
  }).join("");

  detail.innerHTML = html;

  // Update Sources toggle label with error count if any
  const failed = statuses.filter(s => s.error);
  const toggleBtn = document.getElementById("sources-toggle");
  if (toggleBtn && failed.length > 0) {
    toggleBtn.textContent = (sourcesOpen ? "Sources ▴" : "Sources ▾") + ` ⚠${failed.length}`;
  }

  // Click handlers
  detail.querySelectorAll(".source-item").forEach(el => {
    el.addEventListener("click", () => {
      const name = el.dataset.source;
      activeSource   = (activeSource === name) ? null : name;
      activeCategory = null;

      detail.querySelectorAll(".source-item").forEach(i =>
        i.classList.toggle("active", i.dataset.source === activeSource)
      );
      syncFilterButtons();
      applyFilters();
    });
  });
}

function initSourcesToggle() {
  // The toggle button is now a static element inside stats-count (#sources-toggle).
  const btn = document.getElementById("sources-toggle");
  if (!btn) return;

  btn.addEventListener("click", () => {
    const detail = document.getElementById("sources-detail");
    if (!detail) return;
    sourcesOpen = !sourcesOpen;
    detail.classList.toggle("visible", sourcesOpen);
    const base = "Sources";
    const errorPart = btn.textContent.includes("⚠") ? " " + btn.textContent.split(" ").pop() : "";
    btn.textContent = (sourcesOpen ? `${base} ▴` : `${base} ▾`) + errorPart;
    btn.classList.toggle("active", sourcesOpen);
  });
}

/* ============================================================
   RENDER — category filters
   ============================================================ */

function syncFilterButtons() {
  // Sync category filter buttons
  document.querySelectorAll(".filter-btn").forEach(btn => {
    const isAll = btn.textContent === "All";
    btn.classList.toggle("active",
      (isAll && activeCategory === null && activeSource === null) ||
      (!isAll && btn.textContent === activeCategory)
    );
  });
  // Sync sources toggle button
  const srcToggle = document.getElementById("sources-toggle");
  if (srcToggle) srcToggle.classList.toggle("active", activeSource !== null || sourcesOpen);
}

function renderCategoryFilters(articles) {
  const wrap = document.getElementById("filter-buttons");
  if (!wrap) return;
  wrap.innerHTML = "";

  const cats = displayCategories(articles);

  const allBtn = document.createElement("button");
  allBtn.className   = "filter-btn" + (activeCategory === null && activeSource === null ? " active" : "");
  allBtn.textContent = "All";
  allBtn.onclick     = () => {
    activeCategory = null;
    activeSource   = null;
    document.querySelectorAll(".source-item").forEach(i => i.classList.remove("active"));
    applyFilters();
  };
  wrap.appendChild(allBtn);

  for (const cat of cats) {
    const btn = document.createElement("button");
    btn.className   = "filter-btn" + (activeCategory === cat ? " active" : "");
    btn.textContent = cat;
    btn.onclick     = () => {
      activeCategory = cat;
      activeSource   = null;
      document.querySelectorAll(".source-item").forEach(i => i.classList.remove("active"));
      applyFilters();
    };
    wrap.appendChild(btn);
  }
}

/* ============================================================
   RENDER — article card
   ============================================================ */

function buildArticleCard(article, colorIndex) {
  const color   = colorForIndex(colorIndex);
  const preview = stripHtml(article.description);
  const clipped = preview.length > 300 ? preview.slice(0, 297) + "…" : preview;
  const timeStr = formatDate(article.pubDate);
  const catCls  = categoryClass(article.category);

  return `
<div class="article-card" style="animation-delay:${(colorIndex % 20) * 30}ms">
  <div class="card-accent ${escHtml(color)}"></div>
  <div class="card-body">
    <div class="card-meta">
      <span class="card-source">${escHtml(article.source)}</span>
      ${timeStr ? `<span class="card-time">${escHtml(timeStr)}</span>` : ""}
      ${article.category ? `<span class="card-category ${catCls}">${escHtml(article.category)}</span>` : ""}
    </div>
    <div class="card-title">
      <a href="${escHtml(article.link)}" target="_blank" rel="noopener noreferrer">
        ${escHtml(article.title)}
      </a>
    </div>
    ${clipped ? `<div class="card-preview">${escHtml(clipped)}</div>` : ""}
    <a class="card-read" href="${escHtml(article.link)}" target="_blank" rel="noopener noreferrer">Read →</a>
  </div>
</div>`.trim();
}

/* ============================================================
   RENDER — apply filters + draw list
   ============================================================ */

function applyFilters() {
  syncFilterButtons();

  let filtered;

  if (activeSource) {
    // Pull directly from raw per-source cache — up to 15 most recent
    const raw = (rawBySource[activeSource] || [])
      .slice()
      .sort((a, b) => {
        const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
        const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
        return db - da;
      })
      .slice(0, 15);
    filtered = raw;
  } else if (activeCategory === "Gov & Legal") {
    filtered = allArticles.filter(a => GOV_LEGAL_CATS.has(a.category));
  } else if (activeCategory) {
    filtered = allArticles.filter(a => a.category === activeCategory);
  } else {
    filtered = allArticles;
  }

  const wrapper = document.getElementById("articles-wrapper");
  if (!wrapper) return;

  if (filtered.length === 0) {
    wrapper.innerHTML = `<div class="empty-state">No articles available.</div>`;
    renderStatsBar(0);
    return;
  }

  wrapper.innerHTML = filtered.map((a, i) => buildArticleCard(a, i)).join("\n");
  renderStatsBar(filtered.length);
}

/* ============================================================
   LOADING UI
   ============================================================ */

function showLoadingState() {
  const wrapper = document.getElementById("articles-wrapper");
  if (wrapper) {
    wrapper.innerHTML = `
<div class="status-row">
  <div class="spinner"></div>
  <span id="loading-text">Fetching feeds…</span>
  <div class="progress-bar-wrap">
    <div class="progress-bar" id="progress-bar" style="width:0%"></div>
  </div>
</div>`;
  }
  renderStatsBar(0);
}

function updateProgress(done, total) {
  const bar  = document.getElementById("progress-bar");
  const text = document.getElementById("loading-text");
  if (bar)  bar.style.width = `${Math.round((done / total) * 100)}%`;
  if (text) text.textContent = `Loading ${done} / ${total} feeds…`;
}

function showLoadError(message) {
  const wrapper = document.getElementById("articles-wrapper");
  if (wrapper) {
    wrapper.innerHTML = `<div class="error-card">⚠ ${escHtml(message)}</div>`;
  }
}

/* ============================================================
   MAIN FETCH LOOP
   ============================================================ */

async function loadAllFeeds(force = false) {
  if (isLoading) return;
  isLoading = true;

  const refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) refreshBtn.disabled = true;

  if (force) {
    CFG.sources.forEach(s => {
      try { localStorage.removeItem(cacheKey(s.url)); } catch {}
    });
  }

  showLoadingState();

  const sources = CFG.sources;
  if (!sources || sources.length === 0) {
    showLoadError("No sources configured. Add feeds to window.BRIEF_CONFIG.sources in RSSBrief.html.");
    isLoading = false;
    if (refreshBtn) refreshBtn.disabled = false;
    return;
  }

  let done = 0;
  feedStatuses = [];
  rawBySource  = {};

  const results = await Promise.allSettled(
    sources.map(source =>
      fetchFeed(source).then(result => {
        done++;
        updateProgress(done, sources.length);

        // Store raw articles per source (for source-level filtering)
        rawBySource[source.name] = result.articles;

        feedStatuses.push({
          name:      source.name,
          category:  source.category || "Uncategorized",
          ok:        !result.error,
          count:     result.articles.length,
          error:     result.error,
          fromCache: result.fromCache,
        });
        return result.articles;
      })
    )
  );

  // Flatten, sort newest-first
  const rawArticles = results
    .flatMap(r => r.status === "fulfilled" ? r.value : [])
    .sort((a, b) => {
      const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
      const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
      return db - da;
    });

  // Per-source cap (for main feed only)
  const sourceCounts = {};
  const limited = rawArticles.filter(a => {
    sourceCounts[a.source] = (sourceCounts[a.source] || 0) + 1;
    return sourceCounts[a.source] <= CFG.maxPerSource;
  });

  // Deduplicate + total cap
  allArticles = deduplicateArticles(limited).slice(0, CFG.totalArticles);

  writeMeta({ feedCount: sources.length });

  const allFromCache = feedStatuses.length > 0 && feedStatuses.every(s => s.fromCache);

  renderCategoryFilters(allArticles);
  applyFilters();
  renderSourcesPanel(feedStatuses);

  isLoading = false;
  if (refreshBtn) refreshBtn.disabled = false;
}

/* ============================================================
   INIT
   ============================================================ */

document.addEventListener("DOMContentLoaded", () => {
  renderHeader();
  initSourcesToggle();

  const refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => loadAllFeeds(true));
  }

  loadAllFeeds();
});
