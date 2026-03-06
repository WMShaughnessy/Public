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
  dedupThreshold: 0.55,
  freshHours: 6,
  extendedHours: 14,
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
let hasAnimated      = false; // true after first card render — skip animation on updates

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

/**
 * Decode HTML entities in a plain-text string.
 * Handles named entities (&amp; &lt; &gt; &quot; &apos; &nbsp; and the full
 * set of named HTML5 entities via a textarea trick), decimal numeric refs
 * (&#8217;) and hex numeric refs (&#x2019;).
 * Safe to call multiple times — idempotent on already-decoded strings.
 */
function decodeEntities(str) {
  if (!str || str.indexOf("&") === -1) return str;

  // Named entity map for the most common cases (fast path, no DOM needed)
  const NAMED = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
    nbsp: "\u00A0", ndash: "\u2013", mdash: "\u2014",
    lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201C", rdquo: "\u201D",
    hellip: "\u2026", bull: "\u2022", middot: "\u00B7",
    copy: "\u00A9", reg: "\u00AE", trade: "\u2122",
    euro: "\u20AC", pound: "\u00A3", yen: "\u00A5",
    laquo: "\u00AB", raquo: "\u00BB",
    eacute: "\u00E9", egrave: "\u00E8", ecirc: "\u00EA", euml: "\u00EB",
    aacute: "\u00E1", agrave: "\u00E0", acirc: "\u00E2", atilde: "\u00E3",
    auml: "\u00E4", aring: "\u00E5", aelig: "\u00E6",
    oacute: "\u00F3", ograve: "\u00F2", ocirc: "\u00F4", otilde: "\u00F5",
    ouml: "\u00F6", oslash: "\u00F8",
    uacute: "\u00FA", ugrave: "\u00F9", ucirc: "\u00FB", uuml: "\u00FC",
    iacute: "\u00ED", igrave: "\u00EC", icirc: "\u00EE", iuml: "\u00EF",
    ntilde: "\u00F1", ccedil: "\u00E7", szlig: "\u00DF",
    Eacute: "\u00C9", Egrave: "\u00C8", Aacute: "\u00C1", Agrave: "\u00C0",
    Oacute: "\u00D3", Uacute: "\u00DA", Ntilde: "\u00D1",
  };

  return str.replace(/&([a-zA-Z]{2,8}|#\d{1,6}|#x[\da-fA-F]{1,6});/g, (match, ref) => {
    if (ref[0] === "#") {
      // Numeric reference — decimal or hex
      const cp = ref[1] === "x" || ref[1] === "X"
        ? parseInt(ref.slice(2), 16)
        : parseInt(ref.slice(1), 10);
      return isNaN(cp) ? match : String.fromCodePoint(cp);
    }
    // Named reference
    return Object.prototype.hasOwnProperty.call(NAMED, ref) ? NAMED[ref] : match;
  });
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
    // Remove feed-injected truncation markers (anywhere in text)
    .replace(/\s*\[…\]\s*/g, " ")
    .replace(/\s*\[\.\.\.\]\s*/g, " ")
    .replace(/\s*\[[…\.]{1,3}\]\s*/g, " ")
    // Remove trailing-only markers
    .replace(/\s*…\s*$/g, "")
    .replace(/\s*\.{3}\s*$/g, "")
    .replace(/\s*Continue reading\.{0,3}\s*$/gi, "")
    .replace(/\s*Read (Entire |Full |More )?Article\.?\s*$/gi, "")
    // Collapse any double spaces introduced by removals
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Normalize a date string so Date() parses it correctly.
 * rss2json returns dates like "2026-03-06 12:00:00" with no timezone —
 * these are UTC but get parsed as local time, shifting all articles
 * forward/backward depending on the user's timezone.
 */
function normalizeDate(dateStr) {
  if (!dateStr) return null;
  const s = dateStr.trim();
  // If it looks like "YYYY-MM-DD HH:MM:SS" with no timezone info, treat as UTC
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return s.replace(" ", "T") + "Z";
  }
  // "YYYY-MM-DDTHH:MM:SS" (ISO without tz) — also treat as UTC
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) {
    return s + "Z";
  }
  return s;
}

function relativeTime(isoStr) {
  if (!isoStr) return "";
  try {
    const dt = new Date(isoStr);
    const s = Math.floor((Date.now() - dt.getTime()) / 1000);
    if (s < -86400) return `in ${Math.floor(-s / 86400)}d`;
    if (s < -3600)  return `in ${Math.floor(-s / 3600)}h`;
    if (s < -60)    return `in ${Math.floor(-s / 60)}m`;
    if (s < -5)     return "scheduled";
    if (s < 60)     return "just now";
    if (s < 3600)   return `${Math.floor(s / 60)}m ago`;
    if (s < 86400)  return `${Math.floor(s / 3600)}h ago`;
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
 * Strip a literal suffix from a title (e.g. sanitize_headline: " - Reuters").
 * Comparison is case-sensitive and trims the result.
 */
function sanitizeTitle(title, strip) {
  if (!strip || !title) return title;
  if (title.endsWith(strip)) return title.slice(0, -strip.length).trimEnd();
  return title;
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

/**
 * Sanitize article description for display.
 * Strips all HTML except <a> tags, which are preserved as safe clickable links.
 * Any <a> without visible text falls back to the href as link text.
 */
function sanitizePreview(html) {
  if (!html) return "";

  // Extract and stash <a> tags, replacing them with placeholders
  const links = [];
  const withPlaceholders = html.replace(/<a\b([^>]*)>(.*?)<\/a>/gis, (_, attrs, inner) => {
    const hrefMatch = attrs.match(/href=["']([^"']+)["']/i);
    const href      = hrefMatch ? hrefMatch[1] : "";
    // Strip any nested tags from the link text
    const text = inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const label = text || href;
    if (!href) return label; // no href — just render the text
    links.push({ href, label });
    return `\x00LINK${links.length - 1}\x00`;
  });

  // Strip remaining HTML from the rest of the content
  let plain = withPlaceholders
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
    // Remove feed-injected truncation markers (anywhere in text)
    .replace(/\s*\[…\]\s*/g, " ")
    .replace(/\s*\[\.\.\.\]\s*/g, " ")
    .replace(/\s*\[[…\.]{1,3}\]\s*/g, " ")
    // Remove trailing-only markers
    .replace(/\s*…\s*$/g, "")
    .replace(/\s*\.{3}\s*$/g, "")
    .replace(/\s*Continue reading\.{0,3}\s*$/gi, "")
    .replace(/\s*Read (Entire |Full |More )?Article\.?\s*$/gi, "")
    // Collapse any double spaces introduced by removals
    .replace(/\s{2,}/g, " ")
    .trim();

  // Re-inject sanitized <a> tags in place of placeholders
  plain = plain.replace(/\x00LINK(\d+)\x00/g, (_, i) => {
    const { href, label } = links[Number(i)];
    return `<a href="${escHtml(href)}" target="_blank" rel="noopener noreferrer" class="preview-link">${escHtml(label)}</a>`;
  });

  return plain;
}

/* ============================================================
   CACHING  (localStorage)
   ============================================================ */

function cacheKey(sourceUrl) {
  // Simple string hash to avoid collisions from btoa truncation
  let hash = 0;
  for (let i = 0; i < sourceUrl.length; i++) {
    const ch = sourceUrl.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0; // 32-bit integer
  }
  return CACHE_PREFIX + Math.abs(hash).toString(36);
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

/**
 * Filter out promotional / ad-like / buyer-guide Tech articles.
 * Checks title and description for deal/savings/ad/listicle patterns.
 */
const TECH_SPAM_PATTERNS = [
  // Deals & pricing
  /\bdeal(?:s)?\b/i,
  /\bsaving(?:s)?\b/i,
  /\bsale\b/i,
  /\bdiscount(?:s|ed)?\b/i,
  /\bcoupon(?:s)?\b/i,
  /\bpromo(?:tion|s|tional)?\b/i,
  /\bcheap(?:est|er)?\b/i,
  /\bbargain(?:s)?\b/i,
  /\b(?:flash|clearance)\s*sale/i,
  /\bprice\s*(?:drop|cut|slash)/i,
  /\b\d+\s*%\s*off\b/i,
  /\$\d+\s*off\b/i,
  /\bunder\s*\$\d+/i,
  /\bfor\s*(?:just|only)\s*\$/i,
  /\blowest\s*price/i,
  /\bbuy\s*one\s*get/i,
  /\bbest\s*(?:buy|price|deal)/i,
  /\bsave\s*\$\d+/i,
  /\baffordable\b/i,
  /\bgift\s*(?:guide|idea|pick)/i,
  /\bsponsored\b/i,
  // Buyer guides & listicles
  /\bbest\s+.{0,30}\s+for\s+20\d\d/i,
  /\bbest\s+.{0,30}\s+in\s+20\d\d/i,
  /\bbest\s+.{0,30}\s+of\s+20\d\d/i,
  /\btop\s+\d+\s+(?:best\s+)?/i,
  /\bbuyer'?s?\s*guide/i,
  /\bbuying\s*guide/i,
  /\bwe\s+(?:like|love|recommend|tested|picked|reviewed)/i,
  /\bour\s+(?:favorite|pick|top)/i,
  /\bworth\s+(?:buying|it)\b/i,
  /\bshould\s+you\s+buy\b/i,
  // Plans & subscriptions (consumer comparison)
  /\b(?:prepaid|phone|cell|data|streaming|wireless)\s*plan/i,
  /\bvs\.?\s+.{0,20}\s+vs\.?\b/i,
  // Budget / value framing
  /\bbudget\b/i,
  /\bbang\s+for\s+(?:your|the)\s+buck/i,
  /\bvalue\s+(?:pick|for\s+money)/i,
];

function isTechSpam(article) {
  const text = ((article.title || "") + " " + (article.description || "")).toLowerCase();
  return TECH_SPAM_PATTERNS.some(rx => rx.test(text));
}

/**
 * Fill the article list with a weighted ratio favoring "News".
 * Cycle: 6 News, 2 Business, 2 Gov/Legal, 1 Tech per 11 slots.
 * Tech articles are pre-filtered to remove deal/ad spam.
 *
 * Recency windows are configurable via BRIEF_CONFIG:
 *   freshHours    — primary pool (default 6)
 *   extendedHours — backfill pool (default 14)
 * Articles older than extendedHours are never shown.
 *
 * After selection, the final list is sorted newest-first for display.
 */
function weightedCategoryFill(articles, total) {
  const NEWS_SLOTS   = 6;
  const BIZ_SLOTS    = 2;
  const GOVLEG_SLOTS = 2;
  const TECH_SLOTS   = 1;
  const CYCLE        = NEWS_SLOTS + BIZ_SLOTS + GOVLEG_SLOTS + TECH_SLOTS; // 11
  const FRESH_MS    = (CFG.freshHours    || 6)  * 60 * 60 * 1000;
  const EXTENDED_MS = (CFG.extendedHours || 14) * 60 * 60 * 1000;

  const now = Date.now();

  // Strictly bucket — tech spam excluded everywhere
  const fresh    = [];
  const extended = [];
  for (const a of articles) {
    if (a.category === "Tech" && isTechSpam(a)) continue;
    const t = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const age = now - t;
    if (t > 0 && age >= 0 && age <= FRESH_MS) {
      fresh.push(a);
    } else if (t > 0 && age > FRESH_MS && age <= EXTENDED_MS) {
      extended.push(a);
    }
    // >14h articles are dropped entirely
  }

  // First pass: weighted fill using ONLY fresh (≤6h) articles
  const freshResult = _weightedSelect(fresh, total, NEWS_SLOTS, BIZ_SLOTS, GOVLEG_SLOTS, TECH_SLOTS, CYCLE);

  // If we couldn't fill all slots, pull from extended (6-14h) using
  // the same weighted selection so the ratio is preserved.
  if (freshResult.length < total) {
    const needed = total - freshResult.length;
    const usedSet = new Set(freshResult.map(a => a.title + "|" + a.source));
    const extPool = extended.filter(a => !usedSet.has(a.title + "|" + a.source));

    const extFill = _weightedSelect(extPool, needed, NEWS_SLOTS, BIZ_SLOTS, GOVLEG_SLOTS, TECH_SLOTS, CYCLE);
    freshResult.push(...extFill);
  }

  // Sort newest-first for display
  freshResult.sort((a, b) => {
    const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return db - da;
  });

  return freshResult;
}

/** Internal: weighted category select from a pool */
function _weightedSelect(pool, total, NEWS_SLOTS, BIZ_SLOTS, GOVLEG_SLOTS, TECH_SLOTS, CYCLE) {
  const news   = pool.filter(a => a.category === "News");
  const biz    = pool.filter(a => a.category === "Business");
  const govleg = pool.filter(a => GOV_LEGAL_CATS.has(a.category));
  const tech   = pool.filter(a => a.category === "Tech");
  // Anything else goes into an overflow bucket
  const other  = pool.filter(a =>
    a.category !== "News" && a.category !== "Business" &&
    a.category !== "Tech" && !GOV_LEGAL_CATS.has(a.category)
  );

  const selected = [];
  let ni = 0, bi = 0, gi = 0, ti = 0, oi = 0;
  const NEWS_END   = NEWS_SLOTS;
  const BIZ_END    = NEWS_END + BIZ_SLOTS;
  const GOVLEG_END = BIZ_END + GOVLEG_SLOTS;

  while (selected.length < total) {
    const pos = selected.length % CYCLE;
    let pushed = false;

    if (pos < NEWS_END) {
      // News slot — fallback to biz → govleg → other → tech
      if (ni < news.length)          { selected.push(news[ni++]); pushed = true; }
      else if (bi < biz.length)      { selected.push(biz[bi++]); pushed = true; }
      else if (gi < govleg.length)   { selected.push(govleg[gi++]); pushed = true; }
      else if (oi < other.length)    { selected.push(other[oi++]); pushed = true; }
      else if (ti < tech.length)     { selected.push(tech[ti++]); pushed = true; }
    } else if (pos < BIZ_END) {
      // Business slot — fallback to govleg → news → other → tech
      if (bi < biz.length)           { selected.push(biz[bi++]); pushed = true; }
      else if (gi < govleg.length)   { selected.push(govleg[gi++]); pushed = true; }
      else if (ni < news.length)     { selected.push(news[ni++]); pushed = true; }
      else if (oi < other.length)    { selected.push(other[oi++]); pushed = true; }
      else if (ti < tech.length)     { selected.push(tech[ti++]); pushed = true; }
    } else if (pos < GOVLEG_END) {
      // Gov & Legal slot — fallback to biz → news → other → tech
      if (gi < govleg.length)        { selected.push(govleg[gi++]); pushed = true; }
      else if (bi < biz.length)      { selected.push(biz[bi++]); pushed = true; }
      else if (ni < news.length)     { selected.push(news[ni++]); pushed = true; }
      else if (oi < other.length)    { selected.push(other[oi++]); pushed = true; }
      else if (ti < tech.length)     { selected.push(tech[ti++]); pushed = true; }
    } else {
      // Tech slot — fallback to other → govleg → biz → news
      if (ti < tech.length)          { selected.push(tech[ti++]); pushed = true; }
      else if (oi < other.length)    { selected.push(other[oi++]); pushed = true; }
      else if (gi < govleg.length)   { selected.push(govleg[gi++]); pushed = true; }
      else if (bi < biz.length)      { selected.push(biz[bi++]); pushed = true; }
      else if (ni < news.length)     { selected.push(news[ni++]); pushed = true; }
    }

    if (!pushed) break;
  }

  return selected;
}

/* ============================================================
   FETCH  —  rss2json → corsproxy fallback
   ============================================================ */

async function fetchFeedViaRss2Json(source) {
  const params = new URLSearchParams({
    rss_url: source.url,
  });
  if (CFG.rss2jsonApiKey) {
    params.set("api_key",   CFG.rss2jsonApiKey);
    params.set("count",     String(Math.max(CFG.maxPerSource * 3, 15)));
    params.set("order_by",  "pubDate");
    params.set("order_dir", "desc");
  }

  const res = await fetch(`https://api.rss2json.com/v1/api.json?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  if (data.status !== "ok") throw new Error(data.message || "rss2json error");

  return (data.items || []).map(item => ({
    title:       sanitizeTitle(item.title || "Untitled", source.sanitize_headline),
    link:        item.link  || item.guid || "",
    pubDate:     normalizeDate(item.pubDate) || null,
    description: item.description || item.content || "",
    source:      source.name,
    category:    source.category || "Uncategorized",
    sourceUrl:   source.url,
    headlineOnly: !!source.headline_only,
  }));
}

async function fetchFeedViaCorsProxy(source) {
  // Try corsproxy.io first (new URL format: /?url=), then allorigins fallback
  const proxies = [
    url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
    url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  ];

  let lastError;
  for (const makeUrl of proxies) {
    try {
      const res = await fetch(makeUrl(source.url));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const text   = await res.text();
      const parser = new DOMParser();
      const doc    = parser.parseFromString(text, "application/xml");

      // Check for XML parse errors
      const parseError = doc.querySelector("parsererror");
      if (parseError) throw new Error("XML parse error");

      const items  = Array.from(doc.querySelectorAll("item, entry"));
      if (items.length === 0) throw new Error("No items found");

      return items.map(item => {
        const get = sel => {
          const el = item.querySelector(sel);
          return el ? (el.textContent || "") : "";
        };
        const linkEl  = item.querySelector("link");
        const link    = get("link") || linkEl?.getAttribute("href") || "";
        const pubDate = get("pubDate") || get("published") || get("updated") || null;

        return {
          title:       sanitizeTitle(get("title") || "Untitled", source.sanitize_headline),
          link:        link.trim(),
          pubDate:     pubDate ? normalizeDate(pubDate.trim()) : null,
          description: get("description") || get("summary") || get("content") || "",
          source:      source.name,
          category:    source.category || "Uncategorized",
          sourceUrl:   source.url,
          headlineOnly: !!source.headline_only,
        };
      });
    } catch (e) {
      lastError = e;
      continue;
    }
  }
  throw lastError || new Error("All CORS proxies failed");
}

/**
 * Apply per-source transforms to a list of articles.
 * Runs on both freshly-fetched and cached articles so config changes
 * (headline_only, sanitize_headline) take effect immediately without
 * needing a cache bust.
 */
function applySourceTransforms(articles, source) {
  return articles.map(a => {
    let title = decodeEntities(a.title || "Untitled");

    // Strip literal suffix from title (e.g. " - Reuters")
    if (source.sanitize_headline) {
      title = sanitizeTitle(title, source.sanitize_headline);
    }

    // Strip markdown-style bold (__text__) that some feeds (e.g. Google News
    // aggregating Reuters) inject into the description
    let description = decodeEntities(a.description || "")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1");

    return {
      ...a,
      title,
      description,
      headlineOnly: !!source.headline_only,
    };
  });
}

async function fetchFeed(source) {
  const cached = readCache(source.url);
  if (cached) {
    return { articles: applySourceTransforms(cached.articles, source), fromCache: true, error: null };
  }
  try {
    const articles = applySourceTransforms(await fetchFeedViaRss2Json(source), source);
    writeCache(source.url, articles);
    return { articles, fromCache: false, error: null };
  } catch (e1) {
    console.warn(`[RSSBrief] rss2json failed for "${source.name}": ${e1.message}`);
    try {
      const articles = applySourceTransforms(await fetchFeedViaCorsProxy(source), source);
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
  if (titleEl) titleEl.innerHTML = '<a href="index.html" style="color:inherit;text-decoration:none;">' + CFG.title + '</a>';
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

  const STALE_MS = 48 * 60 * 60 * 1000; // 48 hours

  // Group by category
  const groups = {};
  for (const s of statuses) {
    const cat = s.category || "Uncategorized";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(s);
  }

  const html = Object.keys(groups).sort().map(cat => {
    const items = groups[cat].slice().sort((a, b) => a.name.localeCompare(b.name)).map(s => {
      const isActive   = activeSource === s.name;

      // Determine staleness — only for sources that have dated articles
      const isStale = s.latestPubDate && (Date.now() - s.latestPubDate > STALE_MS);
      const staleLabel = isStale ? relativeTime(new Date(s.latestPubDate).toISOString()) : "";

      let statusCls, statusIcon;
      if (s.error) {
        statusCls  = "src-fail";
        statusIcon = "✗";
      } else if (isStale) {
        statusCls  = "src-stale";
        statusIcon = "⚠";
      } else if (s.fromCache) {
        statusCls  = "src-cache";
        statusIcon = "↩";
      } else {
        statusCls  = "src-ok";
        statusIcon = "✓";
      }

      return `<div class="source-item ${isActive ? "active" : ""} ${statusCls}"
                   data-source="${escHtml(s.name)}">
        <span class="src-icon">${statusIcon}</span>
        <span class="src-name">${escHtml(s.name)}</span>
        ${isStale ? `<span class="src-stale-age">${escHtml(staleLabel)}</span>` : ""}
      </div>`;
    }).join("");

    return `<div class="source-group">
      <div class="source-group-label">${escHtml(cat)}</div>
      ${items}
    </div>`;
  }).join("");

  detail.innerHTML = html;



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
    btn.textContent = sourcesOpen ? "Sources ▴" : "Sources ▾";
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
  const preview = sanitizePreview(article.description);
  const timeStr = formatDate(article.pubDate);
  const catCls  = categoryClass(article.category);

  // Generous character limit for preview text
  const PREVIEW_LIMIT = 280;
  let previewHtml = "";
  if (preview && !article.headlineOnly) {
    const plainText = preview.replace(/<[^>]+>/g, "");
    if (plainText.length > PREVIEW_LIMIT) {
      // Truncate at word boundary from the plain text, but we need to
      // truncate the rich HTML carefully. We walk the raw HTML and track
      // visible-character count to find the cut point.
      const cutIndex = findHtmlCutPoint(preview, PREVIEW_LIMIT);
      const truncated = preview.slice(0, cutIndex).replace(/\s+$/, "");
      const cardId = `card-preview-${colorIndex}-${Date.now()}`;
      previewHtml = `
        <div class="card-preview card-preview-truncated" id="${cardId}">
          <span class="preview-short">${truncated}… <a href="javascript:void(0)" class="preview-expand-link" onclick="expandPreview('${cardId}')">Expand ▸</a></span>
          <span class="preview-full" style="display:none">${preview} <a href="javascript:void(0)" class="preview-expand-link" onclick="collapsePreview('${cardId}')">Close ▴</a></span>
        </div>`;
    } else {
      previewHtml = `<div class="card-preview">${preview}</div>`;
    }
  }

  const animStyle = hasAnimated ? "" : `animation-delay:${(colorIndex % 20) * 30}ms`;
  const animClass = hasAnimated ? "article-card no-anim" : "article-card";

  return `
<div class="${animClass}" style="${animStyle}">
  <div class="card-accent ${escHtml(color)}"></div>
  <div class="card-body">
    ${timeStr ? `<div class="card-time">${escHtml(timeStr)}</div>` : ""}
    <div class="card-meta">
      <span class="card-source">${escHtml(article.source)}</span>
      ${article.category ? `<span class="card-category ${catCls}">${escHtml(article.category)}</span>` : ""}
    </div>
    <div class="card-title">
      <a href="${escHtml(article.link)}" target="_blank" rel="noopener noreferrer">
        ${escHtml(article.title)}
      </a>
    </div>
    ${previewHtml}
    <a class="card-read" href="${escHtml(article.link)}" target="_blank" rel="noopener noreferrer">Read →</a>
  </div>
</div>`.trim();
}

/**
 * Walk an HTML string and find the character index where the visible
 * (non-tag) character count reaches `limit`. Tries to land on a word
 * boundary by rewinding to the last space within the final 30 chars.
 */
function findHtmlCutPoint(html, limit) {
  let visible = 0;
  let inTag = false;
  let lastSpace = -1;
  for (let i = 0; i < html.length; i++) {
    if (html[i] === "<") { inTag = true; continue; }
    if (html[i] === ">") { inTag = false; continue; }
    if (!inTag) {
      visible++;
      if (html[i] === " ") lastSpace = i;
      if (visible >= limit) {
        // Prefer breaking at a word boundary
        if (lastSpace > i - 30 && lastSpace > 0) return lastSpace;
        return i;
      }
    }
  }
  return html.length;
}

function expandPreview(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.querySelector(".preview-short").style.display = "none";
  el.querySelector(".preview-full").style.display = "inline";
  el.classList.remove("card-preview-truncated");
}

function collapsePreview(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.querySelector(".preview-short").style.display = "inline";
  el.querySelector(".preview-full").style.display = "none";
  el.classList.add("card-preview-truncated");
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
  if (!hasAnimated) hasAnimated = true;
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

  hasAnimated = false;
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

        rawBySource[source.name] = result.articles;

        feedStatuses.push({
          name:      source.name,
          category:  source.category || "Uncategorized",
          ok:        !result.error,
          count:     result.articles.length,
          error:     result.error,
          fromCache: result.fromCache,
          latestPubDate: result.articles.reduce((latest, a) => {
            if (!a.pubDate) return latest;
            const t = new Date(a.pubDate).getTime();
            if (t > Date.now()) return latest;
            return (t > latest) ? t : latest;
          }, 0) || null,
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

  // Per-source cap — News gets a higher allowance since the 6hr time
  // gate in weightedCategoryFill will naturally limit the final count
  const NEWS_PER_SOURCE = 10;
  const sourceCounts = {};
  const limited = rawArticles.filter(a => {
    sourceCounts[a.source] = (sourceCounts[a.source] || 0) + 1;
    const cap = a.category === "News" ? NEWS_PER_SOURCE : CFG.maxPerSource;
    return sourceCounts[a.source] <= cap;
  });

  // Deduplicate + weighted fill
  const deduped = deduplicateArticles(limited);
  allArticles = weightedCategoryFill(deduped, CFG.totalArticles);

  writeMeta({ feedCount: sources.length });

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