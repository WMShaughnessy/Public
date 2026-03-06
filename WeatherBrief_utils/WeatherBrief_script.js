/**
 * Weather Brief — WeatherBrief_script.js
 *
 * Fetches weather data from Open-Meteo + NWS Alerts + reverse geocoding,
 * renders a brutalist editorial weather report using div-based layout.
 *
 * Features:
 *  - localStorage caching with configurable TTL (default 15 min)
 *  - Section filter buttons (Overview, Hourly, Details, Forecast)
 *  - NWS weather advisories
 *  - Card accent color cycling (red → yellow → blue)
 *  - Responsive div-based layout (no tables)
 *  - Live refresh
 */

/* ============================================================
   CONFIG
   ============================================================ */

const DEFAULT_CONFIG = {
  title: "Weather Brief",
  cacheTTLMinutes: 15,
  units: "imperial", // "imperial" or "metric"
};

const CFG = Object.assign({}, DEFAULT_CONFIG, window.WEATHER_CONFIG || {});
const CACHE_KEY = "WeatherBrief_data";

/* ============================================================
   STATE
   ============================================================ */

let weatherData  = null;
let locationData = null;
let alertsData   = [];
let activeSection = null; // null = all
let isLoading    = false;
let colorCounter = 0;

/* ============================================================
   ICONS — clean inline SVGs
   ============================================================ */

const ICON_PATHS = {
  therm:    '<path d="M14 14.76V3.5a2.5 2.5 0 00-5 0v11.26a4.5 4.5 0 105 0z"/>',
  wind:     '<path d="M9.59 4.59A2 2 0 1111 8H2m10.59 11.41A2 2 0 1014 16H2m15.73-8.27A2.5 2.5 0 1119.5 12H2"/>',
  drop:     '<path d="M12 2.69l5.66 5.66a8 8 0 11-11.31 0z"/>',
  sun:      '<circle cx="12" cy="12" r="5"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>',
  sunrise:  '<path d="M17 18a5 5 0 00-10 0M12 2v7M4.22 10.22l1.42 1.42M1 18h2m18 0h2M18.36 11.64l1.42-1.42M23 22H1"/><path d="M8 6l4-4 4 4"/>',
  sunset:   '<path d="M17 18a5 5 0 00-10 0M12 9V2M4.22 10.22l1.42 1.42M1 18h2m18 0h2M18.36 11.64l1.42-1.42M23 22H1"/><path d="M16 6l-4 4-4-4"/>',
  cloud:    '<path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/>',
  eye:      '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  gauge:    '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  compass:  '<circle cx="12" cy="12" r="10"/><polygon points="16.24,7.76 14.12,14.12 7.76,16.24 9.88,9.88"/>',
  rain:     '<path d="M16 13v8M8 13v8M12 15v8M20 16.58A5 5 0 0018 7h-1.26A8 8 0 104 15.25"/>',
  snow:     '<path d="M20 17.58A5 5 0 0018 8h-1.26A8 8 0 104 16.25"/><circle cx="8" cy="16" r=".5"/><circle cx="8" cy="20" r=".5"/><circle cx="12" cy="18" r=".5"/><circle cx="12" cy="22" r=".5"/><circle cx="16" cy="16" r=".5"/><circle cx="16" cy="20" r=".5"/>',
  uv:       '<circle cx="12" cy="12" r="5"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2m18 0h2"/>',
  clock:    '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  map:      '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/>',
  cal:      '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  alert:    '<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4m0 4h.01"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  heart:    '<path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/>',
  arrow:    '<path d="M12 19V5M5 12l7-7 7 7"/>',
  arrowDn:  '<path d="M12 5v14M19 12l-7 7-7-7"/>',
};

function icon(name, size = 16, color = "currentColor") {
  const d = ICON_PATHS[name] || "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">${d}</svg>`;
}

function condIcon(code, size = 16, color = "currentColor") {
  if (code <= 1)  return icon("sun", size, color);
  if (code <= 3)  return icon("cloud", size, color);
  if (code <= 48) return icon("cloud", size, color);
  if (code <= 67) return icon("rain", size, color);
  if (code <= 77) return icon("snow", size, color);
  return icon("rain", size, color);
}

/* ============================================================
   HELPERS
   ============================================================ */

function escHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const COLORS = ["red", "yellow", "blue"];
function nextColor() { return COLORS[colorCounter++ % 3]; }
function resetColors() { colorCounter = 0; }

const WMO = {
  0:"Clear Sky",1:"Mainly Clear",2:"Partly Cloudy",3:"Overcast",
  45:"Foggy",48:"Rime Fog",51:"Light Drizzle",53:"Moderate Drizzle",55:"Dense Drizzle",
  56:"Freezing Drizzle",57:"Dense Freezing Drizzle",61:"Light Rain",63:"Moderate Rain",
  65:"Heavy Rain",66:"Freezing Rain",67:"Heavy Freezing Rain",71:"Light Snow",
  73:"Moderate Snow",75:"Heavy Snow",77:"Snow Grains",80:"Light Showers",
  81:"Moderate Showers",82:"Violent Showers",85:"Light Snow Showers",
  86:"Heavy Snow Showers",95:"Thunderstorm",96:"Thunderstorm + Hail",99:"Severe Thunderstorm"
};

const DIRS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
function degDir(d) { return DIRS[Math.round(d / 22.5) % 16]; }

function cToF(c)     { return (c * 9 / 5 + 32).toFixed(0); }
function mmToIn(mm)   { return (mm / 25.4).toFixed(2); }
function kmhToMph(k)  { return (k * 0.621371).toFixed(0); }
function hpaToInHg(h) { return (h * 0.02953).toFixed(2); }

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function uvLabel(u) {
  if (u <= 2) return "Low";
  if (u <= 5) return "Moderate";
  if (u <= 7) return "High";
  if (u <= 10) return "Very High";
  return "Extreme";
}

function beaufort(k) {
  if (k < 2)  return "Calm";
  if (k < 12) return "Light";
  if (k < 20) return "Gentle Breeze";
  if (k < 29) return "Moderate Breeze";
  if (k < 39) return "Fresh Breeze";
  if (k < 50) return "Strong Breeze";
  if (k < 62) return "Near Gale";
  if (k < 75) return "Gale";
  return "Storm";
}

function dewPt(t, rh) {
  const a = 17.27, b = 237.7, al = (a * t) / (b + t) + Math.log(rh / 100);
  return (b * al) / (a - al);
}

function comfort(t, rh) {
  const f = t * 9 / 5 + 32;
  if (f >= 68 && f <= 77 && rh >= 30 && rh <= 60) return "Very Comfortable";
  if (f >= 60 && f <= 85 && rh >= 20 && rh <= 70) return "Comfortable";
  if (f < 32 || f > 100 || rh > 90) return "Uncomfortable";
  return "Moderate";
}

/* ============================================================
   CACHING
   ============================================================ */

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    const ageMs = Date.now() - entry.savedAt;
    if (ageMs > CFG.cacheTTLMinutes * 60 * 1000) return null;
    return entry;
  } catch { return null; }
}

function writeCache(weather, location, alerts) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      savedAt: Date.now(),
      weather,
      location,
      alerts,
    }));
  } catch (e) {
    console.warn("[WeatherBrief] Cache write failed:", e.message);
  }
}

/* ============================================================
   DATA FETCHING
   ============================================================ */

async function getCityName(lat, lon) {
  try {
    const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    const d = await r.json();
    return {
      name: d.city || d.locality || "My Location",
      country: d.countryName || "",
      code: d.countryCode || "",
      admin: d.principalSubdivision || "",
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  } catch {
    return { name: "My Location", country: "", code: "", admin: "", tz: "" };
  }
}

async function getWeather(lat, lon) {
  const p = new URLSearchParams({
    latitude: lat, longitude: lon, timezone: "auto",
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,snowfall,weather_code,cloud_cover,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
    hourly: "temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,uv_index,visibility,cloud_cover,apparent_temperature",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,sunrise,sunset,uv_index_max,precipitation_sum,precipitation_probability_max,precipitation_hours,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant",
    forecast_days: 7,
  });
  const r = await fetch("https://api.open-meteo.com/v1/forecast?" + p);
  return r.json();
}

async function getAlerts(lat, lon) {
  try {
    const r = await fetch(`https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`, {
      headers: { "User-Agent": "WeatherBrief/1.0", "Accept": "application/geo+json" },
    });
    if (!r.ok) return [];
    const d = await r.json();
    if (!d.features || !d.features.length) return [];
    return d.features.map(f => ({
      event: f.properties.event || "Unknown Alert",
      severity: f.properties.severity || "Unknown",
      urgency: f.properties.urgency || "Unknown",
      headline: f.properties.headline || "",
      description: (f.properties.description || "").substring(0, 300),
      instruction: f.properties.instruction || "",
      sender: f.properties.senderName || "NWS",
      onset: f.properties.onset || "",
      expires: f.properties.expires || "",
    }));
  } catch { return []; }
}

/* ============================================================
   RENDER — Header
   ============================================================ */

function renderHeader() {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  document.getElementById("header-title").textContent = CFG.title;
  document.title = CFG.title;
  document.getElementById("header-date").textContent = dateStr.toUpperCase();
  document.getElementById("header-time").textContent = timeStr;
}

/* ============================================================
   RENDER — Section Filters
   ============================================================ */

const SECTIONS = ["Hourly", "Details", "Forecast"];

function renderFilters() {
  const wrap = document.getElementById("filter-buttons");
  if (!wrap) return;
  wrap.innerHTML = "";

  const allBtn = document.createElement("button");
  allBtn.className = "filter-btn" + (activeSection === null ? " active" : "");
  allBtn.textContent = "All";
  allBtn.onclick = () => { activeSection = null; applyFilters(); };
  wrap.appendChild(allBtn);

  for (const sec of SECTIONS) {
    const btn = document.createElement("button");
    btn.className = "filter-btn" + (activeSection === sec ? " active" : "");
    btn.textContent = sec;
    btn.onclick = () => { activeSection = sec; applyFilters(); };
    wrap.appendChild(btn);
  }
}

function syncFilterButtons() {
  document.querySelectorAll(".filter-btn").forEach(btn => {
    const isAll = btn.textContent === "All";
    btn.classList.toggle("active",
      (isAll && activeSection === null) ||
      (!isAll && btn.textContent === activeSection)
    );
  });
}

/* ============================================================
   RENDER — Build HTML blocks
   ============================================================ */

function buildSection(labelHtml) {
  return `<div class="section-divider"><div class="section-label">${labelHtml}</div></div>`;
}

function buildTag(html) {
  return `<div class="card-tag">${html}</div>`;
}

function buildDataRow(iconHtml, label, value, bold = false) {
  return `<div class="data-row">
    <span class="data-label">${iconHtml}${escHtml(label)}</span>
    <span class="data-value${bold ? " bold" : ""}">${escHtml(value)}</span>
  </div>`;
}

function buildNote(iconHtml, text) {
  return `<div class="data-note">${iconHtml}${text}</div>`;
}

function buildDivider() {
  return `<div class="data-divider"></div>`;
}

function buildCard(tagHtml, innerHtml, animDelay) {
  const color = nextColor();
  const style = animDelay != null ? `animation-delay:${animDelay}ms` : "";
  return `<div class="wx-card" style="${style}">
    <div class="card-accent ${color}"></div>
    <div class="card-body">${tagHtml}${innerHtml}</div>
  </div>`;
}

function buildHero(w) {
  const c = w.current, d = w.daily;
  const cond = WMO[c.weather_code] || "Unknown";
  const color = nextColor();
  return `<div class="hero-card" style="animation-delay:30ms">
    <div class="card-accent ${color}"></div>
    <div class="hero-body">
      <div>
        <div class="hero-temp">${cToF(c.temperature_2m)}°<span class="hero-temp-unit">F</span></div>
        <div class="hero-detail">${icon("therm")} Feels like <strong>${cToF(c.apparent_temperature)}°F</strong></div>
        <div class="hero-detail-sm">${icon("arrow")} High ${cToF(d.temperature_2m_max[0])}° / Low ${cToF(d.temperature_2m_min[0])}°</div>
      </div>
      <div class="hero-right">
        <div>${condIcon(c.weather_code, 52)}</div>
        <div class="hero-condition">${escHtml(cond)}</div>
      </div>
    </div>
  </div>`;
}

function buildHourly(w) {
  const h = w.hourly;
  const hi = new Date().getHours();
  const color = nextColor();
  let items = "";
  for (let i = 0; i < 24; i++) {
    const idx = hi + i;
    if (idx >= h.time.length) break;
    const t = new Date(h.time[idx]);
    const timeLabel = i === 0 ? "Now" : t.toLocaleTimeString("en-US", { hour: "numeric" });
    items += `<div class="hourly-item">
      <div class="hourly-time">${escHtml(timeLabel)}</div>
      <div class="hourly-icon">${condIcon(h.weather_code[idx], 20)}</div>
      <div class="hourly-temp">${cToF(h.temperature_2m[idx])}°</div>
      <div class="hourly-sub">Feels ${cToF(h.apparent_temperature[idx])}°</div>
      <div class="hourly-sub">${icon("drop", 12)} ${h.precipitation_probability[idx]}%</div>
      <div class="hourly-sub">${icon("wind", 12)} ${kmhToMph(h.wind_speed_10m[idx])} mph</div>
      <div class="hourly-sub dim">${icon("cloud", 12)} ${h.cloud_cover[idx]}%</div>
    </div>`;
  }
  return `<div class="wx-card" style="animation-delay:60ms">
    <div class="card-accent ${color}"></div>
    <div class="card-body-scroll">
      ${buildTag(icon("clock", 14, "#fff") + " Hourly Forecast (Next 24 Hours)")}
      <div class="hourly-scroll">${items}</div>
    </div>
  </div>`;
}

function buildCurrentConditions(w) {
  const c = w.current, d = w.daily, h = w.hourly;
  const hi = new Date().getHours();
  const dp = dewPt(c.temperature_2m, c.relative_humidity_2m);
  const uvNow = h.uv_index[hi] !== undefined ? h.uv_index[hi] : d.uv_index_max[0];

  // Temperature card
  const tempRows =
    buildDataRow(icon("therm"), "Temperature", `${cToF(c.temperature_2m)}°F`, true) +
    buildDataRow(icon("therm"), "Feels Like", `${cToF(c.apparent_temperature)}°F`, true) +
    buildDataRow(icon("drop"), "Dew Point", `${cToF(dp)}°F`) +
    buildDataRow(icon("drop"), "Relative Humidity", `${c.relative_humidity_2m}%`) +
    buildDataRow(icon("heart"), "Comfort Level", comfort(c.temperature_2m, c.relative_humidity_2m)) +
    buildDataRow(icon("sun"), "Day / Night", c.is_day ? "Daytime" : "Nighttime") +
    buildDataRow(icon("arrow"), "Today's High", `${cToF(d.temperature_2m_max[0])}°F`) +
    buildDataRow(icon("arrowDn"), "Today's Low", `${cToF(d.temperature_2m_min[0])}°F`) +
    buildDataRow(icon("therm"), "Feels Like Range", `${cToF(d.apparent_temperature_max[0])}° / ${cToF(d.apparent_temperature_min[0])}°`);
  const tempCard = buildCard(buildTag(icon("therm", 14, "#fff") + " Temperature &amp; Comfort"), tempRows);

  // Wind card
  const gustFactor = c.wind_speed_10m > 0 ? (c.wind_gusts_10m / c.wind_speed_10m).toFixed(1) : "—";
  const windRows =
    buildDataRow(icon("wind"), "Sustained Speed", `${kmhToMph(c.wind_speed_10m)} mph`, true) +
    buildDataRow(icon("wind"), "Wind Gusts", `${kmhToMph(c.wind_gusts_10m)} mph`, true) +
    buildDataRow(icon("compass"), "Direction", `${c.wind_direction_10m}° ${degDir(c.wind_direction_10m)}`) +
    buildDataRow(icon("activity"), "Gust Factor", `${gustFactor}x`) +
    buildDataRow(icon("wind"), "Beaufort Scale", beaufort(c.wind_speed_10m)) +
    buildDataRow(icon("wind"), "Today's Max Wind", `${kmhToMph(d.wind_speed_10m_max[0])} mph`) +
    buildDataRow(icon("wind"), "Today's Max Gusts", `${kmhToMph(d.wind_gusts_10m_max[0])} mph`) +
    buildNote(icon("wind"), `Wind is blowing from the ${degDir(c.wind_direction_10m)} at ${kmhToMph(c.wind_speed_10m)} mph with gusts up to ${kmhToMph(c.wind_gusts_10m)} mph.`);
  const windCard = buildCard(buildTag(icon("wind", 14, "#fff") + " Wind"), windRows);

  // Precipitation card
  let totalP = 0, maxPhr = 0, maxPval = 0;
  for (let i = 0; i < 24; i++) {
    const idx = hi + i;
    if (idx < h.precipitation.length) {
      totalP += h.precipitation[idx];
      if (h.precipitation[idx] > maxPval) { maxPval = h.precipitation[idx]; maxPhr = idx; }
    }
  }
  let precipRows =
    buildDataRow(icon("rain"), "Current Precipitation", `${mmToIn(c.precipitation)} in`, true) +
    buildDataRow(icon("rain"), "Current Rain", `${mmToIn(c.rain)} in`) +
    buildDataRow(icon("snow"), "Current Snowfall", `${mmToIn(c.snowfall * 10)} in`) +
    buildDivider() +
    buildDataRow(icon("rain"), "Next 24h Total", `${mmToIn(totalP)} in`, true) +
    buildDataRow(icon("rain"), "Today's Total", `${mmToIn(d.precipitation_sum[0])} in`) +
    buildDataRow(icon("rain"), "Today's Probability", `${d.precipitation_probability_max[0]}%`) +
    buildDataRow(icon("clock"), "Today's Precip Hours", `${d.precipitation_hours[0]}h`);
  if (totalP > 0) {
    precipRows += buildNote(icon("alert"), `Peak precipitation expected around ${fmtTime(h.time[maxPhr])} (${mmToIn(maxPval)} in).`);
  }
  const precipCard = buildCard(buildTag(icon("rain", 14, "#fff") + " Precipitation"), precipRows);

  return tempCard + windCard + precipCard;
}

function buildSolarUV(w) {
  const d = w.daily, h = w.hourly;
  const hi = new Date().getHours();
  const sr = new Date(d.sunrise[0]), ss = new Date(d.sunset[0]);
  const dayMin = (ss - sr) / 1000 / 60;
  const uvNow = h.uv_index[hi] !== undefined ? h.uv_index[hi] : d.uv_index_max[0];

  const sunRows =
    buildDataRow(icon("sunrise"), "Sunrise", fmtTime(d.sunrise[0]), true) +
    buildDataRow(icon("sunset"), "Sunset", fmtTime(d.sunset[0]), true) +
    buildDataRow(icon("clock"), "Total Daylight", `${Math.floor(dayMin / 60)}h ${Math.round(dayMin % 60)}m`) +
    buildDataRow(icon("clock"), "Night Length", `${Math.floor((1440 - dayMin) / 60)}h ${Math.round((1440 - dayMin) % 60)}m`);
  const sunCard = buildCard(buildTag(icon("sunrise", 14, "#fff") + " Sunrise &amp; Sunset"), sunRows);

  let uvTip;
  if (uvNow <= 2) uvTip = "No protection required. Safe for outdoor activities.";
  else if (uvNow <= 5) uvTip = "Wear sunscreen and sunglasses for extended outdoor exposure.";
  else if (uvNow <= 7) uvTip = "Reduce sun exposure between 10am–4pm. Sunscreen and hat recommended.";
  else uvTip = "Minimize sun exposure. Sunscreen, hat, and protective clothing essential.";

  const uvRows =
    buildDataRow(icon("uv"), "Current UV Index", `${uvNow}`, true) +
    buildDataRow(icon("uv"), "Current UV Rating", uvLabel(uvNow), true) +
    buildDataRow(icon("uv"), "Today's Maximum UV", `${d.uv_index_max[0]} (${uvLabel(d.uv_index_max[0])})`) +
    buildNote(icon("alert"), uvTip);
  const uvCard = buildCard(buildTag(icon("uv", 14, "#fff") + " UV Index"), uvRows);

  return sunCard + uvCard;
}

function buildForecast(w) {
  const d = w.daily;
  let html = "";
  for (let i = 0; i < d.time.length; i++) {
    const dt = new Date(d.time[i] + "T00:00:00");
    const dayName = i === 0 ? "Today" : i === 1 ? "Tomorrow" : dt.toLocaleDateString("en-US", { weekday: "long" });
    const dateLabel = dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const cond = WMO[d.weather_code[i]] || "—";
    const color = nextColor();
    const precipNote = d.precipitation_hours[i] > 0
      ? `<div class="fc-precip-note">${icon("clock", 13)} Precipitation expected for ~${d.precipitation_hours[i]} hours</div>`
      : "";

    html += `<div class="wx-card" style="animation-delay:${(i + 4) * 30}ms">
      <div class="card-accent ${color}"></div>
      <div class="card-body">
        <div class="fc-header">
          <div class="card-tag" style="margin-bottom:0">${escHtml(dayName)} · ${escHtml(dateLabel)}</div>
          <div class="fc-condition">${condIcon(d.weather_code[i], 18)} ${escHtml(cond)}</div>
        </div>
        <div class="fc-grid">
          <div class="fc-grid-item">${icon("therm", 14)} High <strong>${cToF(d.temperature_2m_max[i])}°F</strong></div>
          <div class="fc-grid-item">${icon("therm", 14)} Low <strong>${cToF(d.temperature_2m_min[i])}°F</strong></div>
          <div class="fc-grid-item">${icon("therm", 14)} Feels ${cToF(d.apparent_temperature_max[i])}° / ${cToF(d.apparent_temperature_min[i])}°</div>
          <div class="fc-grid-item">${icon("rain", 14)} ${mmToIn(d.precipitation_sum[i])}" (${d.precipitation_probability_max[i]}%)</div>
          <div class="fc-grid-item">${icon("wind", 14)} ${kmhToMph(d.wind_speed_10m_max[i])} mph ${degDir(d.wind_direction_10m_dominant[i])}</div>
          <div class="fc-grid-item">${icon("wind", 14)} Gusts ${kmhToMph(d.wind_gusts_10m_max[i])} mph</div>
          <div class="fc-grid-item">${icon("uv", 14)} UV ${d.uv_index_max[i]} (${uvLabel(d.uv_index_max[i])})</div>
          <div class="fc-grid-item">${icon("sunrise", 14)} ${fmtTime(d.sunrise[i])}</div>
          <div class="fc-grid-item">${icon("sunset", 14)} ${fmtTime(d.sunset[i])}</div>
        </div>
        ${precipNote}
      </div>
    </div>`;
  }
  return html;
}

function buildAlerts(alerts) {
  if (!alerts || alerts.length === 0) return "";
  let items = "";
  for (const a of alerts) {
    const sevClass = (a.severity === "Extreme" || a.severity === "Severe") ? "extreme" : a.severity === "Moderate" ? "moderate" : "";
    const timeRange = (a.onset && a.expires) ? `${fmtTime(a.onset)} – ${fmtTime(a.expires)}` : "";
    items += `<div class="advisory-item">
      <div class="advisory-severity ${sevClass}">${escHtml(a.severity)} · ${escHtml(a.urgency)}</div>
      <div class="advisory-event">${icon("alert", 14)} ${escHtml(a.event)}</div>
      ${a.headline ? `<div class="advisory-headline">${escHtml(a.headline)}</div>` : ""}
      ${timeRange ? `<div class="advisory-time">${icon("clock", 12)} ${escHtml(timeRange)}</div>` : ""}
      ${a.description ? `<div class="advisory-desc">${escHtml(a.description)}${a.description.length >= 300 ? "…" : ""}</div>` : ""}
      ${a.instruction ? `<div class="advisory-instr">${escHtml(a.instruction.substring(0, 200))}${a.instruction.length >= 200 ? "…" : ""}</div>` : ""}
      <div class="advisory-source">Source: ${escHtml(a.sender)}</div>
    </div>`;
  }
  return buildCard(
    buildTag(icon("alert", 14, "#fff") + ` Active Advisories (${alerts.length})`),
    items
  );
}

/* ============================================================
   RENDER — Apply filters + assemble page
   ============================================================ */

function applyFilters() {
  syncFilterButtons();
  if (!weatherData) return;

  const wrapper = document.getElementById("content-wrapper");
  if (!wrapper) return;

  resetColors();
  let html = "";

  const showAll      = activeSection === null;
  const showHourly   = showAll || activeSection === "Hourly";
  const showDetails  = showAll || activeSection === "Details";
  const showForecast = showAll || activeSection === "Forecast";

  // Overview — only when showing all sections
  if (showAll) {
    html += buildSection(icon("sun") + " Overview");

    if (alertsData.length > 0) {
      html += buildAlerts(alertsData);
    }

    html += buildHero(weatherData);
  }

  // Hourly
  if (showHourly) {
    html += buildHourly(weatherData);
  }

  // Current Conditions Detail
  if (showDetails) {
    html += buildSection(icon("therm") + " Current Conditions");
    html += buildCurrentConditions(weatherData);
    html += buildSection(icon("sun") + " Solar &amp; UV");
    html += buildSolarUV(weatherData);
  }

  // 7-Day Forecast
  if (showForecast) {
    html += buildSection(icon("cal") + " 7-Day Forecast");
    html += buildForecast(weatherData);
  }

  wrapper.innerHTML = html;
}

/* ============================================================
   LOADING UI
   ============================================================ */

function updateLoading(text, sub) {
  const lt = document.getElementById("loading-text");
  const ls = document.getElementById("loading-subtext");
  if (lt) lt.textContent = text;
  if (ls) ls.textContent = sub;
}

function hideLoading() {
  const ld = document.getElementById("loading-overlay");
  if (ld) {
    ld.classList.add("hidden");
    setTimeout(() => ld.style.display = "none", 500);
  }
}

function freezeLoading() {
  const la = document.getElementById("loading-accent");
  if (la) {
    la.style.animation = "none";
    la.style.background = "rgb(217, 33, 33)";
  }
}

/* ============================================================
   MAIN
   ============================================================ */

async function loadWeather(force = false) {
  if (isLoading) return;
  isLoading = true;

  const refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) refreshBtn.disabled = true;

  if (force) {
    try { localStorage.removeItem(CACHE_KEY); } catch {}
  }

  // Check cache first
  if (!force) {
    const cached = readCache();
    if (cached) {
      weatherData  = cached.weather;
      locationData = cached.location;
      alertsData   = cached.alerts || [];

      renderHeader();
      renderLocationBar();
      renderFilters();
      applyFilters();
      hideLoading();
      isLoading = false;
      if (refreshBtn) refreshBtn.disabled = false;
      return;
    }
  }

  // Need geolocation
  if (!navigator.geolocation) {
    updateLoading("Geolocation not supported", "Your browser does not support location services.");
    freezeLoading();
    isLoading = false;
    if (refreshBtn) refreshBtn.disabled = false;
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        updateLoading("Fetching weather data...", "Location found. Loading your report.");
        const lat = pos.coords.latitude, lon = pos.coords.longitude;

        const [weather, loc] = await Promise.all([
          getWeather(lat, lon),
          getCityName(lat, lon),
        ]);

        weatherData  = weather;
        locationData = loc;
        alertsData   = [];

        writeCache(weather, loc, []);

        renderHeader();
        renderLocationBar();
        renderFilters();
        applyFilters();
        hideLoading();

        // Fetch alerts in background
        getAlerts(lat, lon).then(alerts => {
          if (alerts && alerts.length > 0) {
            alertsData = alerts;
            writeCache(weather, loc, alerts);
            applyFilters();
          }
        });
      } catch (e) {
        updateLoading("Something went wrong", e.message);
        freezeLoading();
      }
      isLoading = false;
      if (refreshBtn) refreshBtn.disabled = false;
    },
    () => {
      updateLoading("Location access denied", "Please allow location access in your browser settings and reload.");
      freezeLoading();
      isLoading = false;
      if (refreshBtn) refreshBtn.disabled = false;
    }
  );
}

function renderLocationBar() {
  const el = document.getElementById("location-label");
  if (el && locationData) {
    const locStr = `${locationData.name}${locationData.admin ? ", " + locationData.admin : ""}`;
    el.innerHTML = `${icon("map", 14, "#fff")} ${escHtml(locStr).toUpperCase()}`;
  }
}

/* ============================================================
   INIT
   ============================================================ */

document.addEventListener("DOMContentLoaded", () => {
  renderHeader();
  renderFilters();

  const refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => loadWeather(true));
  }

  loadWeather();
});