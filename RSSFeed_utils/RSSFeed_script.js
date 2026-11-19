/**
 * RSS Feed — RSSFeed_script.js
 *
 * Fetches RSS feeds in the browser: directly where the publisher allows it,
 * otherwise through rss2json, then corsproxy.io / allorigins.
 *
 * Features:
 *  - localStorage caching with configurable TTL (default 15 min)
 *  - Remembers the route (direct, rss2json or a proxy) that last worked for
 *    each feed and tries it first; feeds that allow it skip the proxies
 *  - Skips rss2json or a proxy for the rest of a load once it fails 4 times
 *  - At most 8 feeds in flight, each with a 10 s timeout
 *  - Shows saved articles at once, then replaces them as feeds refresh
 *  - A failed feed shows its last good copy (up to 24 h) marked stale
 *  - Refresh only refetches feeds older than 2 minutes
 *  - Saved copies keep each feed's newest 20 items; if storage fills up,
 *    old and unconfigured feeds are cleared first
 *  - Duplicates caught by link as well as by headline
 *  - "Show N" button picks 15 / 30 / 50 / 100 articles, remembered per browser
 *  - Collapsible source list grouped by category, clickable to filter
 *  - Source filter draws up to 15 most recent articles from raw feed cache
 *  - Feed failure indicators per source
 *  - Title-based deduplication across sources
 *  - Category filter buttons (Government + Legal merged)
 *  - Card accent color driven by article category
 *  - Meta/cache status inline in stats bar
 *  - Live refresh
 *  - Progressive article rendering (articles appear as feeds load)
 */

/* ============================================================
   CONFIG
   ============================================================ */

const DEFAULT_CONFIG = {
  title: "RSS Feed",
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
const CACHE_PREFIX   = "RSSFeed_feed_";
const CACHE_META_KEY = "RSSFeed_meta";

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
let clockTimer       = null;

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
 */
function decodeEntities(str) {
  if (!str || str.indexOf("&") === -1) return str;

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
      const cp = ref[1] === "x" || ref[1] === "X"
        ? parseInt(ref.slice(2), 16)
        : parseInt(ref.slice(1), 10);
      return isNaN(cp) ? match : String.fromCodePoint(cp);
    }
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
    .replace(/\s*\[…\]\s*/g, " ")
    .replace(/\s*\[\.\.\.\]\s*/g, " ")
    .replace(/\s*\[[…\.]{1,3}\]\s*/g, " ")
    .replace(/\s*…\s*$/g, "")
    .replace(/\s*\.{3}\s*$/g, "")
    .replace(/\s*Continue reading\.{0,3}\s*$/gi, "")
    .replace(/\s*Read (Entire |Full |More )?Article\.?\s*$/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Normalize a date string so Date() parses it correctly.
 */
function normalizeDate(dateStr) {
  if (!dateStr) return null;
  const s = dateStr.trim();
  // A timestamp with no offset is the publisher's local time, not UTC.
  // Appending "Z" asserted an offset the feed never gave, shifting the item
  // by however far that publisher is from Greenwich -- far enough, for an
  // eastern feed, to look published in the future and be dropped entirely.
  // Hand it to Date() as a naive local time instead, which is the closest
  // reading available and errs by hours rather than by a whole timezone.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return s.replace(" ", "T");
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

/* Parsing a date string is slow next to comparing numbers, and the sorts below
   compare the same articles thousands of times, so each article's timestamp
   is parsed once. NaN when the date is missing or unreadable. */
const pubTimes = new WeakMap();
function pubTime(article) {
  let t = pubTimes.get(article);
  if (t === undefined) {
    t = article.pubDate ? new Date(article.pubDate).getTime() : NaN;
    pubTimes.set(article, t);
  }
  return t;
}

const COLORS = ["red", "yellow", "blue"];

function colorForIndex(i) {
  return COLORS[i % COLORS.length];
}

function categoryClass(cat) {
  if (!cat) return "";
  return "cat-" + cat.toLowerCase().replace(/\s+/g, "-");
}

function sanitizeTitle(title, strip) {
  if (!strip || !title) return title;
  if (title.endsWith(strip)) return title.slice(0, -strip.length).trimEnd();
  return title;
}

function displayCategories(articles) {
  const seen = new Set();
  const cats = [];
  for (const a of articles) {
    const cat = a.category;
    if (!cat) continue;
    const display = GOV_LEGAL_CATS.has(cat) ? "Gov & Legal" : cat;
    if (!seen.has(display)) {
      seen.add(display);
      cats.push(display);
    }
  }
  return cats.sort();
}

/* ------------------------------------------------------------
   Feed content is untrusted input. Everything below it reaches the
   DOM through innerHTML, so the rule is: the only markup that ever
   leaves this section is markup we built ourselves.
   ------------------------------------------------------------ */

function stripTags(str) {
  return String(str)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]*>/g, "");
}

/**
 * A URL we are willing to put in an href.
 *
 * escHtml keeps a value inside its attribute but says nothing about the
 * scheme, so "javascript:..." survived it intact and stayed one click from
 * running. Allow the schemes a news link legitimately uses and reject the
 * rest, including data: and vbscript:. Returns null when there is nothing
 * safe to link to, and the caller renders plain text instead.
 */
function safeHref(url) {
  const u = String(decodeEntities(String(url || ""))).trim();
  if (!u) return null;
  // Browsers strip embedded control characters before resolving a scheme,
  // so "java\tscript:" would run. Refuse anything carrying them.
  if (/[\u0000-\u001F\u007F]/.test(u)) return null;
  if (/^(https?:|mailto:)/i.test(u)) return u;          // ordinary links
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) return null; // any other scheme
  return u;                                             // relative or //host
}

/** Build the one anchor shape this file emits. */
function buildLink(href, label, cls) {
  const safe = safeHref(href);
  const text = escHtml(label);
  if (!safe) return text;
  return `<a href="${escHtml(safe)}" target="_blank" rel="noopener noreferrer"` +
         (cls ? ` class="${cls}"` : "") + `>${text}</a>`;
}

function sanitizePreview(html) {
  if (!html) return "";

  // NUL is our placeholder marker; make sure only we can introduce one.
  const src = String(html).replace(/\u0000/g, "");

  const links = [];
  const withPlaceholders = src.replace(/<a\b([^>]*)>(.*?)<\/a>/gis, (_, attrs, inner) => {
    const hrefMatch = attrs.match(/href=["']([^"']+)["']/i);
    const href      = hrefMatch ? hrefMatch[1] : "";
    const label     = stripTags(String(decodeEntities(inner))).replace(/\s+/g, " ").trim();
    if (!href) return label;
    links.push({ href, label: label || href });
    return `\u0000LINK${links.length - 1}\u0000`;
  });

  // Feeds are inconsistent about escaping: some send markup, some send it
  // escaped once, a few twice. Decode and strip in turn until the text stops
  // changing, so tag-shaped content is removed rather than revealed one layer
  // later -- which is how "&lt;img onerror=...&gt;" used to become a live tag.
  // This loop is tidiness; the escape below is what makes the output safe.
  let plain = withPlaceholders;
  for (let i = 0; i < 3; i++) {
    const next = stripTags(String(decodeEntities(plain)));
    if (next === plain) break;
    plain = next;
  }

  plain = plain
    .replace(/\s+/g, " ")
    .replace(/\s*\[…\]\s*/g, " ")
    .replace(/\s*\[\.\.\.\]\s*/g, " ")
    .replace(/\s*\[[…\.]{1,3}\]\s*/g, " ")
    .replace(/\s*…\s*$/g, "")
    .replace(/\s*\.{3}\s*$/g, "")
    .replace(/\s*Continue reading\.{0,3}\s*$/gi, "")
    .replace(/\s*Read (Entire |Full |More )?Article\.?\s*$/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // The safety boundary. Past this point the string holds no live markup;
  // the placeholders survive because they contain no HTML-special character.
  plain = escHtml(plain);

  return plain.replace(/\u0000LINK(\d+)\u0000/g, (_, i) => {
    const link = links[Number(i)];
    return link ? buildLink(link.href, link.label, "preview-link") : "";
  });
}

/* ============================================================
   CACHING  (localStorage)
   ============================================================ */

function cacheKey(sourceUrl) {
  let hash = 0;
  for (let i = 0; i < sourceUrl.length; i++) {
    const ch = sourceUrl.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return CACHE_PREFIX + Math.abs(hash).toString(36);
}

/** The saved copy of a feed, whatever its age, or null. Callers check savedAt. */
function readCache(sourceUrl) {
  try {
    const raw = localStorage.getItem(cacheKey(sourceUrl));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    return entry && Array.isArray(entry.articles) ? entry : null;
  } catch { return null; }
}

const CACHE_MAX_ITEMS = 20;   // newest items kept per feed; the page never shows more than 15

/** Remove saved feeds that are no longer in the config, then the oldest, to free space. */
function pruneCaches(keepKey) {
  const wanted = new Set((CFG.sources || []).map(src => cacheKey(src.url)));
  const entries = [];
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(CACHE_PREFIX) || key === keepKey) continue;
    if (!wanted.has(key)) { localStorage.removeItem(key); continue; }
    let savedAt = 0;
    try { savedAt = JSON.parse(localStorage.getItem(key)).savedAt || 0; } catch {}
    entries.push({ key, savedAt });
  }
  return entries.sort((a, b) => a.savedAt - b.savedAt);   // oldest first
}

function writeCache(sourceUrl, articles) {
  const key = cacheKey(sourceUrl);
  const newest = articles.slice()
    .sort((a, b) => (pubTime(b) || 0) - (pubTime(a) || 0))
    .slice(0, CACHE_MAX_ITEMS);
  const value = JSON.stringify({ savedAt: Date.now(), articles: newest });
  try {
    localStorage.setItem(key, value);
    return;
  } catch {}
  // Storage is full. Drop feeds no longer configured, then the oldest copies,
  // until this one fits; the copy just fetched is worth more than an old one.
  try {
    const oldest = pruneCaches(key);
    for (;;) {
      try { localStorage.setItem(key, value); return; } catch {}
      const victim = oldest.shift();
      if (!victim) break;
      localStorage.removeItem(victim.key);
    }
  } catch {}
  console.warn("[RSSFeed] Cache write failed: storage full");
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

function titleWords(title) {
  return new Set(normalizeTitle(title).split(" ").filter(w => w.length > 2));
}

/** Jaccard overlap of two word sets; two empty titles count as the same. */
function wordSimilarity(wordsA, wordsB) {
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) { if (wordsB.has(w)) intersection++; }
  return intersection / (wordsA.size + wordsB.size - intersection);
}

/** A link reduced to what identifies the story: no tracking, fragment or trailing slash. */
function linkKey(link) {
  try {
    const u = new URL(link);
    if (!/^https?:$/.test(u.protocol)) return "";
    u.hash = "";
    for (const k of Array.from(u.searchParams.keys())) {
      if (/^(utm_|fbclid$|gclid$|mc_|cmpid$|smid$|taid$)/i.test(k)) u.searchParams.delete(k);
    }
    return (u.host.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "") + u.search).toLowerCase();
  } catch { return ""; }
}

/**
 * Drop repeats: the same link, or a title too close to one already kept.
 * Word sets are built once per article rather than once per comparison --
 * this runs after every feed arrives, over a few hundred articles.
 */
function deduplicateArticles(articles) {
  const kept  = [];
  const links = new Set();
  for (const candidate of articles) {
    const link = linkKey(candidate.link);
    if (link && links.has(link)) continue;
    const words = titleWords(candidate.title);
    if (kept.some(k => wordSimilarity(words, k.words) >= CFG.dedupThreshold)) continue;
    kept.push({ article: candidate, words });
    if (link) links.add(link);
  }
  return kept.map(k => k.article);
}

const TECH_SPAM_PATTERNS = [
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
  /\b(?:prepaid|phone|cell|data|streaming|wireless)\s*plan/i,
  /\bvs\.?\s+.{0,20}\s+vs\.?\b/i,
  /\bbudget\b/i,
  /\bbang\s+for\s+(?:your|the)\s+buck/i,
  /\bvalue\s+(?:pick|for\s+money)/i,
];

function isTechSpam(article) {
  const text = ((article.title || "") + " " + (article.description || "")).toLowerCase();
  return TECH_SPAM_PATTERNS.some(rx => rx.test(text));
}

function weightedCategoryFill(articles, total) {
  const NEWS_SLOTS   = 6;
  const BIZ_SLOTS    = 2;
  const GOVLEG_SLOTS = 2;
  const TECH_SLOTS   = 1;
  const ALERT_SLOTS  = 1;   // falls through to other categories when no alerts are live
  const CYCLE        = NEWS_SLOTS + BIZ_SLOTS + GOVLEG_SLOTS + TECH_SLOTS + ALERT_SLOTS;
  const FRESH_MS    = (CFG.freshHours    || 6)  * 60 * 60 * 1000;
  const EXTENDED_MS = (CFG.extendedHours || 14) * 60 * 60 * 1000;

  const now = Date.now();

  // Three tiers, and every article lands in exactly one of them. Previously
  // an item with no pubDate, an unparseable one, a clock-skewed future one,
  // or simply an age past extendedHours matched no branch and was discarded,
  // so a quiet overnight window could empty the page while every feed was
  // loading perfectly well.
  const fresh    = [];
  const extended = [];
  const rest     = [];
  for (const a of articles) {
    if (a.category === "Tech" && isTechSpam(a)) continue;
    const t = pubTime(a) || 0;
    const age = now - t;
    if (!t || Number.isNaN(t) || age < 0) {
      // No usable timestamp, or one in the future: keep it, rank it last.
      rest.push(a);
    } else if (age <= FRESH_MS) {
      fresh.push(a);
    } else if (age <= EXTENDED_MS) {
      extended.push(a);
    } else {
      rest.push(a);
    }
  }

  const freshResult = _weightedSelect(fresh, total, NEWS_SLOTS, BIZ_SLOTS, GOVLEG_SLOTS, TECH_SLOTS, ALERT_SLOTS, CYCLE);

  const keyOf = a => a.title + "|" + a.source;
  for (const pool of [extended, rest]) {
    if (freshResult.length >= total) break;
    const used = new Set(freshResult.map(keyOf));
    const avail = pool.filter(a => !used.has(keyOf(a)));
    freshResult.push(..._weightedSelect(avail, total - freshResult.length,
      NEWS_SLOTS, BIZ_SLOTS, GOVLEG_SLOTS, TECH_SLOTS, ALERT_SLOTS, CYCLE));
  }

  // Tier first, then recency. Sorting on date alone undoes the tiers: a
  // clock-skewed future stamp would outrank genuinely fresh items, and an
  // unparseable date yields NaN, which makes the comparator inconsistent and
  // leaves the whole order up to the engine.
  const tierOf = new Map();
  fresh.forEach(a    => tierOf.set(a, 0));
  extended.forEach(a => tierOf.set(a, 1));
  rest.forEach(a     => tierOf.set(a, 2));
  const timeOf = a => {
    const t = pubTime(a);
    return Number.isFinite(t) ? t : -Infinity;   // undated sorts last
  };
  freshResult.sort((a, b) => {
    const ta = tierOf.has(a) ? tierOf.get(a) : 2;
    const tb = tierOf.has(b) ? tierOf.get(b) : 2;
    if (ta !== tb) return ta - tb;
    return timeOf(b) - timeOf(a);
  });

  return freshResult;
}

function _weightedSelect(pool, total, NEWS_SLOTS, BIZ_SLOTS, GOVLEG_SLOTS, TECH_SLOTS, ALERT_SLOTS, CYCLE) {
  const news   = pool.filter(a => a.category === "News");
  const biz    = pool.filter(a => a.category === "Business");
  const govleg = pool.filter(a => GOV_LEGAL_CATS.has(a.category));
  const tech   = pool.filter(a => a.category === "Tech");
  const alerts = pool.filter(a => a.category === "Alerts");
  const other  = pool.filter(a =>
    a.category !== "News" && a.category !== "Business" &&
    a.category !== "Tech" && a.category !== "Alerts" &&
    !GOV_LEGAL_CATS.has(a.category)
  );

  const selected = [];
  let ni = 0, bi = 0, gi = 0, ti = 0, ai = 0, oi = 0;
  const NEWS_END   = NEWS_SLOTS;
  const BIZ_END    = NEWS_END + BIZ_SLOTS;
  const GOVLEG_END = BIZ_END + GOVLEG_SLOTS;
  const TECH_END   = GOVLEG_END + TECH_SLOTS;

  while (selected.length < total) {
    const pos = selected.length % CYCLE;
    let pushed = false;

    if (pos < NEWS_END) {
      if (ni < news.length)          { selected.push(news[ni++]); pushed = true; }
      else if (bi < biz.length)      { selected.push(biz[bi++]); pushed = true; }
      else if (gi < govleg.length)   { selected.push(govleg[gi++]); pushed = true; }
      else if (oi < other.length)    { selected.push(other[oi++]); pushed = true; }
      else if (ti < tech.length)     { selected.push(tech[ti++]); pushed = true; }
      else if (ai < alerts.length)   { selected.push(alerts[ai++]); pushed = true; }
    } else if (pos < BIZ_END) {
      if (bi < biz.length)           { selected.push(biz[bi++]); pushed = true; }
      else if (gi < govleg.length)   { selected.push(govleg[gi++]); pushed = true; }
      else if (ni < news.length)     { selected.push(news[ni++]); pushed = true; }
      else if (oi < other.length)    { selected.push(other[oi++]); pushed = true; }
      else if (ti < tech.length)     { selected.push(tech[ti++]); pushed = true; }
      else if (ai < alerts.length)   { selected.push(alerts[ai++]); pushed = true; }
    } else if (pos < GOVLEG_END) {
      if (gi < govleg.length)        { selected.push(govleg[gi++]); pushed = true; }
      else if (bi < biz.length)      { selected.push(biz[bi++]); pushed = true; }
      else if (ni < news.length)     { selected.push(news[ni++]); pushed = true; }
      else if (oi < other.length)    { selected.push(other[oi++]); pushed = true; }
      else if (ti < tech.length)     { selected.push(tech[ti++]); pushed = true; }
      else if (ai < alerts.length)   { selected.push(alerts[ai++]); pushed = true; }
    } else if (pos < TECH_END) {
      if (ti < tech.length)          { selected.push(tech[ti++]); pushed = true; }
      else if (oi < other.length)    { selected.push(other[oi++]); pushed = true; }
      else if (ai < alerts.length)   { selected.push(alerts[ai++]); pushed = true; }
      else if (gi < govleg.length)   { selected.push(govleg[gi++]); pushed = true; }
      else if (bi < biz.length)      { selected.push(biz[bi++]); pushed = true; }
      else if (ni < news.length)     { selected.push(news[ni++]); pushed = true; }
    } else {
      if (ai < alerts.length)        { selected.push(alerts[ai++]); pushed = true; }
      else if (ti < tech.length)     { selected.push(tech[ti++]); pushed = true; }
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
   FETCH  —  each feed's known route first, then direct → rss2json →
             CORS proxies, then its last good copy
   ============================================================ */

const FETCH_TIMEOUT_MS   = 10000;                    // a hung request must not stall the load
const FETCH_CONCURRENCY  = 8;                        // feeds in flight at once
const REFRESH_MIN_AGE_MS = 2 * 60 * 1000;            // Refresh keeps copies younger than this
const STALE_LIMIT_MS     = 24 * 60 * 60 * 1000;      // oldest copy shown when a feed fails
const DIRECT_RETRY_MS    = 7 * 24 * 60 * 60 * 1000;  // re-test a feed that refused direct access
const ROUTE_KEY          = "RSSFeed_routes";
const BREAKER_LIMIT      = 4;                        // failures in a row before a service is skipped

/**
 * An error that says the service itself is in trouble (unreachable, timed
 * out, rate-limiting or erroring), as opposed to one feed it cannot read.
 * Only these count toward the circuit breaker below.
 */
function serviceError(message) {
  const e = new Error(message);
  e.service = true;
  return e;
}

/** Throw for a bad HTTP status, flagging the ones that mean the service is struggling. */
function checkStatus(res) {
  if (res.ok) return;
  if (res.status === 429 || res.status >= 500) throw serviceError(`HTTP ${res.status}`);
  throw new Error(`HTTP ${res.status}`);
}

/** fetch() that gives up after FETCH_TIMEOUT_MS instead of waiting forever. */
async function fetchWithTimeout(url) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } catch (e) {
    // A timeout or a refused connection. For "direct" this is usually the
    // publisher refusing browser access, which the breaker ignores anyway.
    throw serviceError(e.name === "AbortError" ? "Timed out" : (e.message || "Network error"));
  } finally {
    clearTimeout(timer);
  }
}

/* Routes.
   A feed can be read four ways: directly from the publisher (only when the
   publisher allows browsers to), through rss2json, or through one of two CORS
   proxies. Each feed remembers the way that last worked and tries it first
   next time, so a typical load makes one request per feed.

   Direct access cannot be checked in advance, so a feed is tried directly
   once; a refusal is recorded only when another route then succeeds (being
   offline never marks a feed as blocked) and is re-tested after a week. */

let routeMemo = null;

function routesLoad() {
  if (routeMemo) return routeMemo;
  try { routeMemo = JSON.parse(localStorage.getItem(ROUTE_KEY)) || {}; }
  catch { routeMemo = {}; }
  return routeMemo;
}

function routeSave(url, via, directFailed) {
  const memo  = routesLoad();
  const key   = cacheKey(url);
  const entry = memo[key] || {};
  entry.via = via;
  if (via === "direct") entry.directBlockedAt = 0;
  else if (directFailed) entry.directBlockedAt = Date.now();
  memo[key] = entry;
  try { localStorage.setItem(ROUTE_KEY, JSON.stringify(memo)); } catch {}
}

function routeOrder(url) {
  const entry = routesLoad()[cacheKey(url)] || {};
  const directOk = !entry.directBlockedAt || Date.now() - entry.directBlockedAt > DIRECT_RETRY_MS;
  const order = ["direct", "rss2json", "corsproxy", "allorigins"]
    .filter(how => how !== "direct" || directOk);
  if (entry.via && order.includes(entry.via)) {
    order.splice(order.indexOf(entry.via), 1);
    order.unshift(entry.via);
  }
  return order;
}

/* Circuit breaker.
   When rss2json is rate-limiting or a proxy is down, every feed would
   otherwise wait for it to fail before moving on. After BREAKER_LIMIT
   service failures in a row (timeouts, refused connections, HTTP 429/5xx,
   rss2json's own rate-limit message) that service is skipped for the rest
   of the load. A feed the service merely cannot read (a 404, bad XML) does
   not count, so a run of broken feeds cannot switch rss2json off for the
   healthy ones. Direct access is per publisher, so it never trips. Reset on
   every load. */

let serviceFailures = {};

function serviceUsable(how) {
  return how === "direct" || (serviceFailures[how] || 0) < BREAKER_LIMIT;
}

function serviceResult(how, error) {
  if (how === "direct") return;
  if (!error) serviceFailures[how] = 0;
  else if (error.service) serviceFailures[how] = (serviceFailures[how] || 0) + 1;
}

/** First child element with one of these tag names (qualified names work, e.g. "dc:date"). */
function firstTag(item, ...names) {
  for (const name of names) {
    const el = item.getElementsByTagName(name)[0];
    if (el && el.textContent.trim()) return el.textContent;
  }
  return "";
}

/**
 * The story's address. RSS puts it in <link>text</link>; Atom uses
 * <link href> and may list several (self, enclosure, replies), of which the
 * story is rel="alternate" or the one with no rel. <guid> is used only when it
 * is itself a web address.
 */
function itemLink(item) {
  const links = Array.from(item.getElementsByTagName("link"));
  const pick  = links.find(l => l.getAttribute("rel") === "alternate")
             || links.find(l => !l.getAttribute("rel"))
             || links[0];
  const fromLink = pick ? (pick.getAttribute("href") || pick.textContent || "").trim() : "";
  if (fromLink) return fromLink;
  const guid = firstTag(item, "guid", "id").trim();
  return /^https?:\/\//i.test(guid) ? guid : "";
}

/** Turn RSS or Atom XML into article objects. */
function parseFeedXml(text, source) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("XML parse error");

  const items = Array.from(doc.querySelectorAll("item, entry"));
  if (items.length === 0) throw new Error("No items found");

  return items.map(item => {
    const pubDate = firstTag(item, "pubDate", "published", "updated", "dc:date") || null;
    return {
      title:       sanitizeTitle(firstTag(item, "title") || "Untitled", source.sanitize_headline),
      link:        itemLink(item),
      pubDate:     pubDate ? normalizeDate(pubDate.trim()) : null,
      description: firstTag(item, "description", "summary", "content", "content:encoded"),
      source:      source.name,
      category:    source.category || "Uncategorized",
      sourceUrl:   source.url,
      headlineOnly: !!source.headline_only,
    };
  });
}

async function fetchXml(url, source) {
  const res = await fetchWithTimeout(url);
  checkStatus(res);
  return parseFeedXml(await res.text(), source);
}

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

  const res = await fetchWithTimeout(`https://api.rss2json.com/v1/api.json?${params}`);
  checkStatus(res);

  const data = await res.json();
  if (data.status !== "ok") {
    const message = data.message || "rss2json error";
    throw /limit|quota|too many/i.test(message) ? serviceError(message) : new Error(message);
  }

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

const ROUTES = {
  // An https page cannot fetch http, so ask the publisher over https.
  direct:     src => fetchXml(src.url.replace(/^http:\/\//i, "https://"), src),
  rss2json:   fetchFeedViaRss2Json,
  corsproxy:  src => fetchXml(`https://corsproxy.io/?url=${encodeURIComponent(src.url)}`, src),
  allorigins: src => fetchXml(`https://api.allorigins.win/raw?url=${encodeURIComponent(src.url)}`, src),
};

function applySourceTransforms(articles, source) {
  return articles.map(a => {
    let title = decodeEntities(a.title || "Untitled");

    if (source.sanitize_headline) {
      title = sanitizeTitle(title, source.sanitize_headline);
    }

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

/**
 * Get one feed's articles.
 *
 * A saved copy younger than maxAgeMs is used as is. Otherwise the feed's
 * routes are tried in routeOrder(), skipping services the breaker has
 * tripped. If all fail, a saved copy up to STALE_LIMIT_MS old is returned
 * flagged stale, so one bad minute at a proxy does not empty the page.
 */
async function fetchFeed(source, maxAgeMs) {
  const cached = readCache(source.url);
  const age    = cached ? Date.now() - cached.savedAt : Infinity;
  if (cached && age <= maxAgeMs) {
    // writeCache stores post-transform articles, so transforming again would
    // decode entities a second time -- cached text would drift from live text.
    return { articles: cached.articles, fromCache: true, stale: false, error: null };
  }

  let lastError;
  let directFailed = false;
  for (const how of routeOrder(source.url)) {
    if (!serviceUsable(how)) continue;
    try {
      const articles = applySourceTransforms(await ROUTES[how](source), source);
      serviceResult(how, null);
      routeSave(source.url, how, directFailed);
      writeCache(source.url, articles);
      return { articles, fromCache: false, stale: false, error: null };
    } catch (e) {
      serviceResult(how, e);
      if (how === "direct") directFailed = true;
      lastError = e;
      console.warn(`[RSSFeed] ${how} failed for "${source.name}": ${e.message}`);
    }
  }

  const message = lastError ? lastError.message : "All services unavailable";
  if (cached && age <= STALE_LIMIT_MS) {
    return { articles: cached.articles, fromCache: true, stale: true, savedAt: cached.savedAt, error: message };
  }
  console.error(`[RSSFeed] All methods failed for "${source.name}": ${message}`);
  return { articles: [], fromCache: false, stale: false, error: message };
}

/** Run worker over items with at most `limit` running at once. */
async function runPool(items, limit, worker) {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++];
      try { await worker(item); } catch (e) { console.error("[RSSFeed]", e); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/* ============================================================
   RENDER — header
   ============================================================ */

function renderHeader() {
  const titleEl = document.getElementById("header-title");
  if (titleEl) titleEl.innerHTML = '<a href="index.html" style="color:inherit;text-decoration:none;">' + CFG.title + '</a>';
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

/* ============================================================
   RENDER — stats count
   ============================================================ */

/** Article count; null while nothing has loaded yet. */
function renderStatsBar(count) {
  const el = document.getElementById("stats-count-label");
  if (!el) return;
  el.textContent = count === null ? "— ARTICLES" : `${count} ARTICLE${count !== 1 ? "S" : ""}`;
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

  const STALE_MS = 48 * 60 * 60 * 1000;

  const groups = {};
  for (const s of statuses) {
    const cat = s.category || "Uncategorized";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(s);
  }

  const html = Object.keys(groups).sort().map(cat => {
    const items = groups[cat].slice().sort((a, b) => a.name.localeCompare(b.name)).map(s => {
      const isActive   = activeSource === s.name;

      const isStale = s.latestPubDate && (Date.now() - s.latestPubDate > STALE_MS);
      const staleLabel = isStale ? relativeTime(new Date(s.latestPubDate).toISOString()) : "";

      let statusCls, statusIcon, ageLabel = staleLabel;
      if (s.stale) {
        // Fetch failed, but an earlier copy is on the page.
        statusCls  = "src-stale";
        statusIcon = "↩";
        ageLabel   = "saved " + relativeTime(new Date(s.savedAt).toISOString());
      } else if (s.error) {
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

      // Add disabled class when loading
      const disabledCls = isLoading ? "src-disabled" : "";

      return `<div class="source-item ${isActive ? "active" : ""} ${statusCls} ${disabledCls}"
                   data-source="${escHtml(s.name)}">
        <span class="src-icon">${statusIcon}</span>
        <span class="src-name">${escHtml(s.name)}</span>
        ${ageLabel && (isStale || s.stale) ? `<span class="src-stale-age">${escHtml(ageLabel)}</span>` : ""}
      </div>`;
    }).join("");

    return `<div class="source-group">
      <div class="source-group-label">${escHtml(cat)}</div>
      ${items}
    </div>`;
  }).join("");

  detail.innerHTML = html;

  // Click handlers — disabled during loading
  detail.querySelectorAll(".source-item").forEach(el => {
    el.addEventListener("click", () => {
      if (isLoading) return; // Block source selection while loading
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
  document.querySelectorAll(".filter-btn").forEach(btn => {
    const isAll = btn.textContent === "All";
    btn.classList.toggle("active",
      (isAll && activeCategory === null && activeSource === null) ||
      (!isAll && btn.textContent === activeCategory)
    );
  });
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
   RENDER — article card (no animation)
   ============================================================ */

function buildArticleCard(article, colorIndex) {
  const color   = colorForIndex(colorIndex);
  const articleLink = safeHref(article.link);
  const preview = sanitizePreview(article.description);
  const timeStr = formatDate(article.pubDate);
  const catCls  = categoryClass(article.category);

  const PREVIEW_LIMIT = 280;
  let previewHtml = "";
  if (preview && !article.headlineOnly) {
    const plainText = preview.replace(/<[^>]+>/g, "");
    if (plainText.length > PREVIEW_LIMIT) {
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

  return `
<div class="article-card">
  <div class="card-accent ${escHtml(color)}"></div>
  <div class="card-body">
    ${timeStr ? `<div class="card-time">${escHtml(timeStr)}</div>` : ""}
    <div class="card-meta">
      <span class="card-source">${escHtml(article.source)}</span>
      ${article.category ? `<span class="card-category ${catCls}">${escHtml(article.category)}</span>` : ""}
    </div>
    <div class="card-title">
      ${buildLink(article.link, article.title)}
    </div>
    ${previewHtml}
    ${articleLink ? `<a class="card-read" href="${escHtml(articleLink)}" target="_blank" rel="noopener noreferrer">Read →</a>` : ""}
  </div>
</div>`.trim();
}

function findHtmlCutPoint(html, limit) {
  let visible = 0;
  let inTag = false;
  let lastSpace = -1;
  let anchorStart = -1;   // where the anchor we are inside began
  for (let i = 0; i < html.length; i++) {
    const ch = html[i];
    if (ch === "<") {
      inTag = true;
      if (/^<a\b/i.test(html.slice(i, i + 3))) anchorStart = i;
      else if (/^<\/a>/i.test(html.slice(i, i + 4))) anchorStart = -1;
      continue;
    }
    if (ch === ">") { inTag = false; continue; }
    if (inTag) continue;

    // An entity is one character on screen, not five.
    if (ch === "&") {
      const m = /^&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/.exec(html.slice(i));
      if (m) { visible++; i += m[0].length - 1; continue; }
    }

    visible++;
    if (ch === " ") lastSpace = i;
    if (visible >= limit) {
      // Never cut between <a> and </a>: the unclosed anchor would swallow
      // the "Expand" link that follows it. If the anchor starts at the very
      // beginning there is nothing to keep, so leave the preview whole rather
      // than truncating it to nothing.
      if (anchorStart >= 0) return anchorStart > 0 ? anchorStart : html.length;
      if (lastSpace > i - 30 && lastSpace > 0) return lastSpace;
      return i;
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
    const raw = (rawBySource[activeSource] || [])
      .slice()
      .sort((a, b) => (pubTime(b) || 0) - (pubTime(a) || 0))
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

  if (filtered.length === 0 && !isLoading) {
    const allFailed = feedStatuses.length > 0 && feedStatuses.every(st => st.error && !st.count);
    wrapper.innerHTML = allFailed
      ? `<div class="error-card">⚠ Couldn't reach any feeds. Check your connection, then press Refresh.</div>`
      : `<div class="empty-state">No articles available.</div>`;
    renderStatsBar(0);
    return;
  }

  if (filtered.length === 0) {
    // Still loading, no articles yet — keep progress bar visible
    renderStatsBar(null);
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
<div class="status-row" id="loading-status-row">
  <div class="spinner"></div>
  <span id="loading-text">Fetching feeds…</span>
  <div class="progress-bar-wrap">
    <div class="progress-bar" id="progress-bar" style="width:0%"></div>
  </div>
</div>`;
  }
  renderStatsBar(null);
}

function updateProgress(done, total) {
  const bar  = document.getElementById("progress-bar");
  const text = document.getElementById("loading-text");
  if (bar)  bar.style.width = `${Math.round((done / total) * 100)}%`;
  if (text) text.textContent = `Loading ${done} / ${total} feeds…`;
}

/**
 * Ensure the progress bar row exists at the top of the articles wrapper.
 * Called during progressive rendering so articles appear below the bar.
 */
function ensureProgressRow() {
  let row = document.getElementById("loading-status-row");
  if (!row) {
    const wrapper = document.getElementById("articles-wrapper");
    if (!wrapper) return;
    const div = document.createElement("div");
    div.innerHTML = `
<div class="status-row" id="loading-status-row">
  <div class="spinner"></div>
  <span id="loading-text">Fetching feeds…</span>
  <div class="progress-bar-wrap">
    <div class="progress-bar" id="progress-bar" style="width:0%"></div>
  </div>
</div>`;
    wrapper.prepend(div.firstElementChild);
  }
}

function removeProgressRow() {
  const row = document.getElementById("loading-status-row");
  if (row) row.remove();
}

function showLoadError(message) {
  const wrapper = document.getElementById("articles-wrapper");
  if (wrapper) {
    wrapper.innerHTML = `<div class="error-card">⚠ ${escHtml(message)}</div>`;
  }
}

/* ============================================================
   PROGRESSIVE REBUILD — recompute allArticles from current rawBySource
   ============================================================ */

function rebuildArticlesFromRaw() {
  // Flatten all raw articles
  const rawArticles = Object.values(rawBySource)
    .flat()
    .sort((a, b) => (pubTime(b) || 0) - (pubTime(a) || 0));

  // Per-source cap
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
}

/* ============================================================
   MAIN FETCH LOOP — progressive rendering
   ============================================================ */

async function loadAllFeeds(force = false) {
  if (isLoading) return;
  isLoading = true;

  const refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) refreshBtn.disabled = true;

  // A normal load uses saved copies up to cacheTTLMinutes old. Refresh only
  // refetches feeds older than a couple of minutes, so pressing it twice
  // does not send every feed through the proxies again.
  const maxAgeMs = force ? REFRESH_MIN_AGE_MS : CFG.cacheTTLMinutes * 60 * 1000;

  showLoadingState();

  // Alerts and News first, so the top of the page fills in soonest.
  const ORDER   = { Alerts: 0, News: 1 };
  const rank    = s => (s.category in ORDER ? ORDER[s.category] : 2);
  const sources = (CFG.sources || []).slice().sort((a, b) => rank(a) - rank(b));
  if (sources.length === 0) {
    showLoadError("No sources configured. Add feeds to window.BRIEF_CONFIG.sources in RSSFeed.html.");
    isLoading = false;
    if (refreshBtn) refreshBtn.disabled = false;
    return;
  }

  let done = 0;
  feedStatuses    = [];
  rawBySource     = {};
  serviceFailures = {};

  // Draw the page from what is on screen so far. Feeds that come from cache
  // finish within the same instant, so redraws are batched to at most one
  // every 120 ms instead of one per feed (rebuilding dedups a few hundred
  // articles and redraws 30 cards each time).
  let renderTimer = null;
  const renderProgress = () => {
    renderTimer = null;
    if (!isLoading) return;
    // Progressive render: rebuild and display on the "All" tab
    if (activeCategory === null && activeSource === null) {
      rebuildArticlesFromRaw();

      if (allArticles.length > 0) {
        const wrapper = document.getElementById("articles-wrapper");
        if (wrapper) {
          // Render articles, then put the progress bar on top
          wrapper.innerHTML = allArticles.map((a, i) => buildArticleCard(a, i)).join("\n");
          renderStatsBar(allArticles.length);

          // Re-insert progress bar at top while still loading
          if (done < sources.length) {
            const progressHtml = `
<div class="status-row" id="loading-status-row">
  <div class="spinner"></div>
  <span id="loading-text">Loading ${done} / ${sources.length} feeds…</span>
  <div class="progress-bar-wrap">
    <div class="progress-bar" id="progress-bar" style="width:${Math.round((done / sources.length) * 100)}%"></div>
  </div>
</div>`;
            wrapper.insertAdjacentHTML("afterbegin", progressHtml);
          }
        }
      } else {
        // No articles yet — just update progress
        updateProgress(done, sources.length);
      }
    } else {
      // A filter is active — just update progress bar
      updateProgress(done, sources.length);
    }

    // Update category filter buttons progressively
    if (allArticles.length > 0) {
      renderCategoryFilters(allArticles);
    }
  };
  const scheduleRender = () => {
    if (!renderTimer) renderTimer = setTimeout(renderProgress, 120);
  };

  // Start from the saved copies (up to a day old) so the page has articles at
  // once; each feed's entry is replaced as its fresh copy arrives.
  for (const source of sources) {
    const cached = readCache(source.url);
    if (cached && Date.now() - cached.savedAt <= STALE_LIMIT_MS) {
      rawBySource[source.name] = cached.articles;
    }
  }
  if (Object.keys(rawBySource).length > 0) renderProgress();

  await runPool(sources, FETCH_CONCURRENCY, source =>
      fetchFeed(source, maxAgeMs).then(result => {
        done++;

        rawBySource[source.name] = result.articles;

        const now = Date.now();
        feedStatuses.push({
          name:      source.name,
          category:  source.category || "Uncategorized",
          ok:        !result.error,
          count:     result.articles.length,
          error:     result.error,
          fromCache: result.fromCache,
          stale:     result.stale,
          savedAt:   result.savedAt || null,
          latestPubDate: result.articles.reduce((latest, a) => {
            const t = pubTime(a);
            if (!Number.isFinite(t) || t > now) return latest;
            return (t > latest) ? t : latest;
          }, 0) || null,
        });

        scheduleRender();
        return result.articles;
      })
  );
  clearTimeout(renderTimer);

  // Final rebuild to ensure consistent state
  rebuildArticlesFromRaw();

  writeMeta({ feedCount: sources.length });

  // Mark loading complete BEFORE final render so sources panel is clickable
  isLoading = false;

  renderCategoryFilters(allArticles);
  applyFilters(); // This now renders without any progress bar
  renderSourcesPanel(feedStatuses);

  if (refreshBtn) refreshBtn.disabled = false;
}

/* ============================================================
   ARTICLE COUNT  —  "Show N" button cycles through COUNT_CHOICES
   ============================================================ */

const COUNT_CHOICES = [15, 30, 50, 100];
const COUNT_KEY     = "RSSFeed_count";

/** The viewer's saved choice, else the config's totalArticles. */
function loadArticleCount() {
  try {
    const saved = parseInt(localStorage.getItem(COUNT_KEY), 10);
    if (COUNT_CHOICES.includes(saved)) CFG.totalArticles = saved;
  } catch {}
}

function renderCountButton() {
  const btn = document.getElementById("count-btn");
  if (!btn) return;
  btn.textContent = `Show ${CFG.totalArticles}`;
  btn.setAttribute("aria-label", `Showing up to ${CFG.totalArticles} articles. Press to change.`);
}

function initCountButton() {
  const btn = document.getElementById("count-btn");
  if (!btn) return;
  renderCountButton();
  btn.addEventListener("click", () => {
    const i = COUNT_CHOICES.indexOf(CFG.totalArticles);
    CFG.totalArticles = COUNT_CHOICES[(i + 1) % COUNT_CHOICES.length];
    try { localStorage.setItem(COUNT_KEY, String(CFG.totalArticles)); } catch {}
    renderCountButton();
    // While loading, the next progressive redraw picks the new count up.
    if (isLoading) return;
    rebuildArticlesFromRaw();
    // A smaller count can leave the chosen category with no articles.
    if (activeCategory && !displayCategories(allArticles).includes(activeCategory)) {
      activeCategory = null;
    }
    renderCategoryFilters(allArticles);
    applyFilters();
  });
}

/* ============================================================
   INIT
   ============================================================ */

/** Delete caches left by the page's old name (RSS Brief). */
function clearOldCaches() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith("RSSBrief_")) localStorage.removeItem(key);
    }
  } catch {}
}

document.addEventListener("DOMContentLoaded", () => {
  clearOldCaches();
  loadArticleCount();
  renderHeader();
  initSourcesToggle();
  initCountButton();

  // Background tabs run timers late; catch the clock up on return.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) renderClock(); });

  const refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => loadAllFeeds(true));
  }

  loadAllFeeds();
});