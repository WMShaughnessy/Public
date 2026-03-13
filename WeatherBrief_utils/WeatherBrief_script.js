/**
 * Weather Brief — WeatherBrief_script.js
 *
 * Fetches weather data from Open-Meteo + NWS Alerts + reverse geocoding,
 * renders a brutalist editorial weather report using div-based layout.
 *
 * Now includes GOES satellite imagery with band switching and
 * plain-language duration controls.
 */

/* ============================================================
   CONFIG
   ============================================================ */

const DEFAULT_CONFIG = {
  title: "Weather Brief",
  cacheTTLMinutes: 15,
  units: "imperial",
};

const CFG = Object.assign({}, DEFAULT_CONFIG, window.WEATHER_CONFIG || {});
const CACHE_KEY     = "WeatherBrief_data";
const GEO_CACHE_KEY = "WeatherBrief_geo";

/* ============================================================
   STATE
   ============================================================ */

let weatherData   = null;
let locationData  = null;
let alertsData    = [];
let activeSection = null; // null = all
let isLoading     = false;
let colorCounter  = 0;
let lastUpdatedAt = null;

/* ============================================================
   SATELLITE STATE
   ============================================================ */

let satCurrentBand     = 'GEOCOLOR';
let satCurrentDuration = 'last-2-hours';  // default
let satFrames          = [];
let satPlaying         = false;
let satTimer           = null;
let satCurrentFrame    = 0;
let satInterval        = 150; // ms between frames
let satResolvedSector  = null;

const GOES_CDN  = 'https://cdn.star.nesdis.noaa.gov';
const GOES_PAGE = 'https://www.star.nesdis.noaa.gov/GOES';

const SAT_BANDS = [
  { id: 'GEOCOLOR',                label: 'GeoColor',         desc: 'True color day, infrared night' },
  { id: 'DayNightCloudMicroCombo', label: 'Cloud Micro',      desc: 'Cloud reflectance and fog' },
  { id: 'Sandwich',                label: 'Sandwich',         desc: 'Visible + IR combo' },
  { id: 'AirMass',                 label: 'Air Mass',         desc: 'IR + water vapor composite' },
  { id: 'FireTemperature',         label: 'Fire',             desc: 'Fire detection' },
  { id: 'Dust',                    label: 'Dust',             desc: 'Dust detection' },
  { id: '02',                      label: 'Visible',          desc: '0.64 µm red visible' },
  { id: '09',                      label: 'Water Vapor',      desc: '6.9 µm mid-level WV' },
  { id: '13',                      label: 'IR (10.3µm)',      desc: 'Longwave infrared' },
  { id: '14',                      label: 'IR (11.2µm)',      desc: 'Longwave infrared' },
];

const SAT_DURATIONS = [
  { id: 'last-1-hour',   label: 'Last hour',     maxFrames: 6 },
  { id: 'last-2-hours',  label: 'Last 2 hours',  maxFrames: 12 },
  { id: 'last-4-hours',  label: 'Last 4 hours',  maxFrames: 24 },
  { id: 'last-6-hours',  label: 'Last 6 hours',  maxFrames: 36 },
  { id: 'last-12-hours', label: 'Last 12 hours', maxFrames: 72 },
  { id: 'max',           label: 'All available',  maxFrames: 120 },
];

const SAT_SECTORS = [
  { id: 'ne',  sat: 'GOES19', p: 'G19', label: 'Northeast',          latMin: 37, latMax: 48, lonMin: -80,  lonMax: -66 },
  { id: 'se',  sat: 'GOES19', p: 'G19', label: 'Southeast',          latMin: 24, latMax: 37, lonMin: -90,  lonMax: -74 },
  { id: 'gl',  sat: 'GOES19', p: 'G19', label: 'Great Lakes',        latMin: 38, latMax: 50, lonMin: -95,  lonMax: -80 },
  { id: 'umv', sat: 'GOES19', p: 'G19', label: 'Upper Miss. Valley', latMin: 38, latMax: 50, lonMin: -110, lonMax: -95 },
  { id: 'sp',  sat: 'GOES19', p: 'G19', label: 'Southern Plains',    latMin: 25, latMax: 38, lonMin: -105, lonMax: -88 },
  { id: 'smv', sat: 'GOES19', p: 'G19', label: 'Southern Miss. Val', latMin: 25, latMax: 38, lonMin: -92,  lonMax: -75 },
  { id: 'nr',  sat: 'GOES19', p: 'G19', label: 'Northern Rockies',   latMin: 38, latMax: 50, lonMin: -117, lonMax: -103 },
  { id: 'sr',  sat: 'GOES19', p: 'G19', label: 'Southern Rockies',   latMin: 25, latMax: 40, lonMin: -117, lonMax: -103 },
  { id: 'pnw', sat: 'GOES18', p: 'G18', label: 'Pacific NW',         latMin: 42, latMax: 55, lonMin: -130, lonMax: -115 },
  { id: 'psw', sat: 'GOES18', p: 'G18', label: 'Pacific SW',         latMin: 30, latMax: 42, lonMin: -130, lonMax: -115 },
];

function resolveSector(lat, lon) {
  for (const s of SAT_SECTORS) {
    if (lat >= s.latMin && lat <= s.latMax && lon >= s.lonMin && lon <= s.lonMax) return s;
  }
  return SAT_SECTORS[0]; // fallback to NE
}

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
  chart:    '<path d="M18 20V10M12 20V4M6 20v-6"/>',
  satellite:'<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 010 8.49m-8.48-.01a6 6 0 010-8.49m11.31-2.82a10 10 0 010 14.14m-14.14 0a10 10 0 010-14.14"/>',
  play:     '<polygon points="5,3 19,12 5,21"/>',
  pause:    '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
  skipBack: '<polygon points="19,20 9,12 19,4"/><line x1="5" y1="19" x2="5" y2="5"/>',
  skipFwd:  '<polygon points="5,4 15,12 5,20"/><line x1="19" y1="5" x2="19" y2="19"/>',
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

function cToF(c)      { return (c * 9 / 5 + 32).toFixed(0); }
function mmToIn(mm)    { return (mm / 25.4).toFixed(2); }
function kmhToMph(k)   { return (k * 0.621371).toFixed(0); }

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function hourLabel(isoStr, isFirst) {
  if (isFirst) return "Now";
  return new Date(isoStr).toLocaleTimeString("en-US", { hour: "numeric" });
}

function findHourlyStart(hourlyTimes) {
  const now = new Date();
  const currentHourStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
  for (let i = 0; i < hourlyTimes.length; i++) {
    if (new Date(hourlyTimes[i]) >= currentHourStart) return i;
  }
  return 0;
}

function relativeTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)    return "just now";
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
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
    if (Date.now() - entry.savedAt > CFG.cacheTTLMinutes * 60 * 1000) return null;
    return entry;
  } catch { return null; }
}

function writeCache(weather, location, alerts) {
  try {
    const now = Date.now();
    localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: now, weather, location, alerts }));
    lastUpdatedAt = now;
  } catch (e) { console.warn("[WeatherBrief] Cache write failed:", e.message); }
}

function readGeoCache() {
  try {
    const raw = localStorage.getItem(GEO_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeGeoCache(lat, lon) {
  try { localStorage.setItem(GEO_CACHE_KEY, JSON.stringify({ lat, lon })); } catch {}
}

/* ============================================================
   DATA FETCHING
   ============================================================ */

async function getCityName(lat, lon) {
  try {
    const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    const d = await r.json();
    return { name: d.city || d.locality || "My Location", country: d.countryName || "", code: d.countryCode || "", admin: d.principalSubdivision || "", tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
  } catch { return { name: "My Location", country: "", code: "", admin: "", tz: "" }; }
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
      event: f.properties.event || "Unknown Alert", severity: f.properties.severity || "Unknown",
      urgency: f.properties.urgency || "Unknown", headline: f.properties.headline || "",
      description: (f.properties.description || "").substring(0, 300),
      instruction: f.properties.instruction || "", sender: f.properties.senderName || "NWS",
      onset: f.properties.onset || "", expires: f.properties.expires || "",
    }));
  } catch { return []; }
}

async function geocodeZip(zip) {
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(zip)}&count=1&language=en&format=json&country_code=US`);
  if (!r.ok) throw new Error("Geocoding request failed");
  const d = await r.json();
  if (!d.results || !d.results.length) throw new Error("ZIP code not found");
  const place = d.results[0];
  return { lat: place.latitude, lon: place.longitude, name: place.name || zip, admin: place.admin1 || "" };
}

/* ============================================================
   SATELLITE — CDN directory fetch & frame parsing
   ============================================================ */

function satCdnDir(sector, band) {
  return GOES_CDN + '/' + sector.sat + '/ABI/SECTOR/' + sector.id + '/' + band + '/';
}

function satViewerUrl(sector, band) {
  return GOES_PAGE + '/sector_band.php?sat=' + sector.p + '&sector=' + sector.id + '&band=' + band + '&length=12';
}

/**
 * Parse a CDN filename timestamp.
 * Pattern: YYYYDDDHHMM_GOES19-ABI-ne-GEOCOLOR-1200x1200.jpg
 */
function parseFrameTimestamp(filename) {
  const ts = filename.split('_')[0];
  if (!ts || ts.length < 11) return null;
  const yr  = parseInt(ts.slice(0, 4), 10);
  const doy = parseInt(ts.slice(4, 7), 10);
  const hr  = parseInt(ts.slice(7, 9), 10);
  const mn  = ts.slice(9, 11);
  const d = new Date(Date.UTC(yr, 0, doy, hr, parseInt(mn, 10)));
  const month = d.getUTCMonth() + 1;
  const day   = d.getUTCDate();
  const year  = d.getUTCFullYear();
  const h     = d.getUTCHours();
  const ampm  = h >= 12 ? 'PM' : 'AM';
  const h12   = h % 12 || 12;
  return month + '/' + day + '/' + year + ' ' + h12 + ':' + mn + ' ' + ampm + ' UTC';
}

async function fetchSatFrames(sector, band, maxFrames) {
  const size = '1200x1200';
  const dirUrl = satCdnDir(sector, band);
  const res = await fetch(dirUrl);
  if (!res.ok) throw new Error('CDN directory fetch failed: ' + res.status);
  const html = await res.text();

  let regex = new RegExp('href="([^"]*' + size + '\\.jpg)"', 'gi');
  let frames = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    frames.push(dirUrl + match[1]);
  }

  // Fallback sizes
  if (frames.length === 0) {
    const fallbacks = ['600x600', '1800x1800', '2400x2400'];
    for (const fb of fallbacks) {
      const fbRegex = new RegExp('href="([^"]*' + fb + '\\.jpg)"', 'gi');
      while ((match = fbRegex.exec(html)) !== null) {
        frames.push(dirUrl + match[1]);
      }
      if (frames.length > 0) break;
    }
  }

  frames.sort();
  if (frames.length > maxFrames) {
    frames = frames.slice(frames.length - maxFrames);
  }
  return frames;
}

/* ============================================================
   SATELLITE — Player controls
   ============================================================ */

function satStop() {
  satPlaying = false;
  clearInterval(satTimer);
  satTimer = null;
}

function satShowFrame(idx) {
  if (!satFrames.length) return;
  satCurrentFrame = idx;
  const img = document.getElementById('sat-image');
  const slider = document.getElementById('sat-slider');
  const tsLabel = document.getElementById('sat-timestamp');
  const counter = document.getElementById('sat-counter');
  const playBtn = document.getElementById('sat-play-btn');

  if (img) img.src = satFrames[idx];
  if (slider) { slider.max = satFrames.length - 1; slider.value = idx; }
  if (counter) counter.textContent = (idx + 1) + ' / ' + satFrames.length;

  if (tsLabel) {
    const fname = satFrames[idx].split('/').pop();
    const ts = parseFrameTimestamp(fname);
    tsLabel.textContent = ts || 'Frame ' + (idx + 1);
  }

  if (playBtn) {
    playBtn.innerHTML = satPlaying ? icon('pause', 14, '#fff') : icon('play', 14, '#fff');
  }
}

function satPlay() {
  if (!satFrames.length) return;
  satPlaying = true;
  satTimer = setInterval(() => {
    satCurrentFrame = (satCurrentFrame + 1) % satFrames.length;
    satShowFrame(satCurrentFrame);
  }, satInterval);
  satShowFrame(satCurrentFrame);
}

function satPause() {
  satStop();
  satShowFrame(satCurrentFrame);
}

function satTogglePlay() {
  if (satPlaying) satPause(); else satPlay();
}

function satStepBack() {
  satPause();
  const idx = satCurrentFrame - 1 < 0 ? satFrames.length - 1 : satCurrentFrame - 1;
  satShowFrame(idx);
}

function satStepFwd() {
  satPause();
  const idx = (satCurrentFrame + 1) % satFrames.length;
  satShowFrame(idx);
}

async function satLoad() {
  const geo = readGeoCache();
  if (!geo) return;

  satStop();
  satFrames = [];

  const sector = resolveSector(geo.lat, geo.lon);
  satResolvedSector = sector;
  const dur = SAT_DURATIONS.find(d => d.id === satCurrentDuration) || SAT_DURATIONS[1];

  // Update header
  const headerEl = document.getElementById('sat-sector-label');
  if (headerEl) headerEl.textContent = sector.label + ' Sector';

  // Show loading state
  const img = document.getElementById('sat-image');
  const tsLabel = document.getElementById('sat-timestamp');
  const counter = document.getElementById('sat-counter');
  if (tsLabel) tsLabel.textContent = 'Loading frames…';
  if (counter) counter.textContent = '';

  // Show the latest static image while loading
  if (img) {
    img.src = satCdnDir(sector, satCurrentBand) + 'latest.jpg';
    img.alt = 'Loading satellite…';
  }

  try {
    satFrames = await fetchSatFrames(sector, satCurrentBand, dur.maxFrames);
    if (satFrames.length === 0) {
      if (tsLabel) tsLabel.textContent = 'No frames available';
      return;
    }
    // Preload
    satFrames.forEach(url => { const i = new Image(); i.src = url; });
    satShowFrame(satFrames.length - 1);
    satPlay();
  } catch (e) {
    if (tsLabel) tsLabel.textContent = 'Could not load — showing latest';
    console.warn('[Satellite]', e);
  }
}

function onBandChange(bandId) {
  satCurrentBand = bandId;
  // Update button states
  document.querySelectorAll('.sat-band-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.band === bandId);
  });
  satLoad();
}

function onDurationChange(durId) {
  satCurrentDuration = durId;
  document.querySelectorAll('.sat-dur-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.dur === durId);
  });
  satLoad();
}

/* ============================================================
   RENDER — Header & Stats
   ============================================================ */

function renderHeader() {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  document.getElementById("header-title").innerHTML = '<a href="index.html" style="color:inherit;text-decoration:none;">' + CFG.title + '</a>';
  document.title = CFG.title;
  document.getElementById("header-date").textContent = dateStr.toUpperCase();
  document.getElementById("header-time").textContent = timeStr;
}

function renderLastUpdated() {
  const el = document.getElementById("last-updated");
  if (!el) return;
  el.textContent = lastUpdatedAt ? `Updated ${relativeTime(lastUpdatedAt)}` : "";
}

function renderLocationBar() {
  const el = document.getElementById("location-label");
  if (el && locationData) {
    const locStr = `${locationData.name}${locationData.admin ? ", " + locationData.admin : ""}`;
    el.innerHTML = `${icon("map", 14, "#fff")} ${escHtml(locStr).toUpperCase()}`;
  }
}

/* ============================================================
   RENDER — Section Filters
   ============================================================ */

const SECTIONS = ["Hourly", "Details", "Forecast", "Satellite"];

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
    btn.classList.toggle("active", (isAll && activeSection === null) || (!isAll && btn.textContent === activeSection));
  });
}

/* ============================================================
   RENDER — Build blocks
   ============================================================ */

function buildSection(labelHtml) {
  return `<div class="section-divider"><div class="section-label">${labelHtml}</div></div>`;
}
function buildTag(html) {
  return `<div class="card-tag">${html}</div>`;
}
function buildDataRow(iconHtml, label, value, bold = false) {
  return `<div class="data-row"><span class="data-label">${iconHtml}${escHtml(label)}</span><span class="data-value${bold ? " bold" : ""}">${escHtml(value)}</span></div>`;
}
function buildNote(iconHtml, text) {
  return `<div class="data-note">${iconHtml}${text}</div>`;
}
function buildDivider() {
  return `<div class="data-divider"></div>`;
}
function buildCard(tagHtml, innerHtml) {
  const color = nextColor();
  return `<div class="wx-card"><div class="card-accent ${color}"></div><div class="card-body">${tagHtml}${innerHtml}</div></div>`;
}

function buildHero(w) {
  const c = w.current, d = w.daily;
  const cond = WMO[c.weather_code] || "Unknown";
  const color = nextColor();
  return `<div class="hero-card"><div class="card-accent ${color}"></div><div class="hero-body">
    <div>
      <div class="hero-temp">${cToF(c.temperature_2m)}°<span class="hero-temp-unit">F</span></div>
      <div class="hero-detail">${icon("therm")} Feels like <strong>${cToF(c.apparent_temperature)}°F</strong></div>
      <div class="hero-detail-sm">${icon("arrow")} High ${cToF(d.temperature_2m_max[0])}° / Low ${cToF(d.temperature_2m_min[0])}°</div>
    </div>
    <div class="hero-right"><div>${condIcon(c.weather_code, 52)}</div><div class="hero-condition">${escHtml(cond)}</div></div>
  </div></div>`;
}

function buildHourly(w) {
  const h = w.hourly;
  const startIdx = findHourlyStart(h.time);
  const color = nextColor();
  let items = "";
  for (let i = 0; i < 24; i++) {
    const idx = startIdx + i;
    if (idx >= h.time.length) break;
    items += `<div class="hourly-item">
      <div class="hourly-time">${escHtml(hourLabel(h.time[idx], i === 0))}</div>
      <div class="hourly-icon">${condIcon(h.weather_code[idx], 28)}</div>
      <div class="hourly-temp">${cToF(h.temperature_2m[idx])}°</div>
      <div class="hourly-feels">Feels ${cToF(h.apparent_temperature[idx])}°</div>
      <div class="hourly-sub">${icon("drop", 13)} ${h.precipitation_probability[idx]}%</div>
      <div class="hourly-sub">${icon("wind", 13)} ${kmhToMph(h.wind_speed_10m[idx])} mph</div>
      <div class="hourly-sub dim">${icon("cloud", 13)} ${h.cloud_cover[idx]}%</div>
    </div>`;
  }
  return buildSection(icon("clock") + " Hourly Forecast (Next 24 Hours)") +
    `<div class="wx-card"><div class="card-accent ${color}"></div>
    <div class="card-body-scroll">
      <div class="hourly-scroll">${items}</div>
    </div></div>`;
}

/* ============================================================
   RENDER — SVG Graphs with interactive tooltips
   ============================================================ */

let chartIdCounter = 0;

const CHART_W = 580, CHART_H = 160;
const CHART_PL = 44, CHART_PR = 10, CHART_PT = 20, CHART_PB = 32;
const CHART_PW = CHART_W - CHART_PL - CHART_PR;
const CHART_PH = CHART_H - CHART_PT - CHART_PB;

function buildSvgChart(opts) {
  const { values, labels, lineColor, fillColor, bars, barColor, unit = "", yMin: forceMin, yMax: forceMax, showDots = true } = opts;
  const W = CHART_W, H = CHART_H, PL = CHART_PL, PR = CHART_PR, PT = CHART_PT, PB = CHART_PB;
  const pW = CHART_PW, pH = CHART_PH;
  const n = values.length;
  if (n < 2) return "";

  const dMin = Math.min(...values), dMax = Math.max(...values);
  const yMin = forceMin != null ? forceMin : dMin - (dMax - dMin) * 0.15;
  const yMax = forceMax != null ? forceMax : dMax + (dMax - dMin) * 0.15;
  const yR = yMax - yMin || 1;
  const xp = i => PL + (i / (n - 1)) * pW;
  const yp = v => PT + pH - ((v - yMin) / yR) * pH;

  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" class="wx-chart">`;

  for (let j = 0; j <= 2; j++) {
    const gy = PT + (j / 2) * pH, gv = yMax - (j / 2) * yR;
    s += `<line x1="${PL}" y1="${gy}" x2="${W - PR}" y2="${gy}" stroke="#e0e0e0" stroke-width="1"/>`;
    s += `<text x="${PL - 6}" y="${gy + 4}" text-anchor="end" fill="#666" font-size="9" font-family="Helvetica Neue,Helvetica,Arial,sans-serif">${Math.round(gv)}${unit}</text>`;
  }

  if (bars && bars.length === n) {
    const bMax = Math.max(...bars) || 1;
    const bW = Math.max(pW / n * 0.6, 3);
    for (let i = 0; i < n; i++) {
      if (bars[i] <= 0) continue;
      const bh = (bars[i] / bMax) * pH * 0.8;
      s += `<rect x="${xp(i) - bW / 2}" y="${PT + pH - bh}" width="${bW}" height="${bh}" fill="${barColor || "rgba(27,75,154,0.25)"}" rx="1"/>`;
    }
  }

  let pathD = "";
  for (let i = 0; i < n; i++) pathD += (i === 0 ? "M" : "L") + `${xp(i).toFixed(1)},${yp(values[i]).toFixed(1)}`;
  s += `<path d="${pathD}L${xp(n - 1).toFixed(1)},${(PT + pH)}L${xp(0).toFixed(1)},${(PT + pH)}Z" fill="${fillColor}" opacity="0.15"/>`;
  s += `<path d="${pathD}" fill="none" stroke="${lineColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;

  if (showDots) {
    const step = n <= 12 ? 1 : n <= 24 ? 2 : 3;
    for (let i = 0; i < n; i += step) s += `<circle cx="${xp(i).toFixed(1)}" cy="${yp(values[i]).toFixed(1)}" r="2.5" fill="${lineColor}" stroke="#fff" stroke-width="1"/>`;
  }

  const ls = n <= 8 ? 1 : n <= 16 ? 2 : n <= 24 ? 3 : 4;
  for (let i = 0; i < n; i += ls) s += `<text x="${xp(i).toFixed(1)}" y="${H - 4}" text-anchor="middle" fill="#666" font-size="8" font-family="Helvetica Neue,Helvetica,Arial,sans-serif">${labels[i]}</text>`;

  return s + "</svg>";
}

function buildInteractiveChart(svgHtml, series, legendHtml) {
  const id = `chart-${chartIdCounter++}`;
  const dataAttr = escHtml(JSON.stringify(series.map(s => ({
    values: s.values, labels: s.labels, color: s.color, unit: s.unit || "",
    yMin: s.yMin, yMax: s.yMax, name: s.name || "",
  }))));

  const dots = series.map((s, i) =>
    `<div class="chart-dot-active" id="${id}-dot-${i}" style="background:${s.color}"></div>`
  ).join("");

  return `<div class="chart-wrap" id="${id}" data-series="${dataAttr}">
    ${svgHtml}
    <div class="chart-crosshair" id="${id}-xhair"></div>
    ${dots}
    <div class="chart-tooltip" id="${id}-tip"></div>
  </div>${legendHtml || ""}`;
}

function bindChartInteractions() {
  document.querySelectorAll(".chart-wrap").forEach(wrap => {
    const id = wrap.id;
    let seriesData;
    try { seriesData = JSON.parse(wrap.dataset.series); } catch { return; }

    const xhair = document.getElementById(`${id}-xhair`);
    const tip   = document.getElementById(`${id}-tip`);
    const dots  = seriesData.map((_, i) => document.getElementById(`${id}-dot-${i}`));

    function show(clientX) {
      const rect = wrap.getBoundingClientRect();
      const fracX = (clientX - rect.left) / rect.width;
      const svgX = fracX * CHART_W;
      const n = seriesData[0].values.length;
      const plotFrac = (svgX - CHART_PL) / CHART_PW;
      const idx = Math.round(plotFrac * (n - 1));
      if (idx < 0 || idx >= n) { hide(); return; }

      const dataFracX = CHART_PL / CHART_W + (idx / (n - 1)) * (CHART_PW / CHART_W);
      const pxX = dataFracX * rect.width;

      xhair.style.left = pxX + "px";
      xhair.style.height = (CHART_PH / CHART_H * rect.height) + "px";
      xhair.style.top = (CHART_PT / CHART_H * rect.height) + "px";
      xhair.style.display = "block";

      const lines = [];
      for (let si = 0; si < seriesData.length; si++) {
        const s = seriesData[si];
        const val = s.values[idx];
        const yR = (s.yMax - s.yMin) || 1;
        const yFrac = (val - s.yMin) / yR;
        const pxY = ((CHART_PT + CHART_PH - yFrac * CHART_PH) / CHART_H) * rect.height;

        if (dots[si]) {
          dots[si].style.left = pxX + "px";
          dots[si].style.top = pxY + "px";
          dots[si].style.display = "block";
        }
        const prefix = s.name ? s.name + ": " : "";
        lines.push(`${prefix}${val}${s.unit}`);
      }

      const timeLabel = seriesData[0].labels[idx];
      tip.innerHTML = `<div style="font-size:9px;opacity:0.7;margin-bottom:2px">${escHtml(timeLabel)}</div>` + lines.join("<br>");
      tip.style.display = "block";

      let tipLeft = pxX;
      const tipRect = tip.getBoundingClientRect();
      const halfTip = tipRect.width / 2;
      if (tipLeft - halfTip < 0) tipLeft = halfTip + 2;
      if (tipLeft + halfTip > rect.width) tipLeft = rect.width - halfTip - 2;
      tip.style.left = tipLeft + "px";
    }

    function hide() {
      xhair.style.display = "none";
      tip.style.display = "none";
      dots.forEach(d => { if (d) d.style.display = "none"; });
    }

    wrap.addEventListener("mousemove", e => show(e.clientX));
    wrap.addEventListener("touchmove", e => {
      e.preventDefault();
      if (e.touches.length > 0) show(e.touches[0].clientX);
    }, { passive: false });
    wrap.addEventListener("mouseleave", hide);
    wrap.addEventListener("touchend", hide);
    wrap.addEventListener("touchcancel", hide);
  });
}

function buildGraphs(w) {
  const h = w.hourly;
  const startIdx = findHourlyStart(h.time);
  const count = Math.min(24, h.time.length - startIdx);
  const temps = [], feels = [], precip = [], precipProb = [], wind = [], timeLabels = [];

  for (let i = 0; i < count; i++) {
    const idx = startIdx + i;
    temps.push(Number(cToF(h.temperature_2m[idx])));
    feels.push(Number(cToF(h.apparent_temperature[idx])));
    precip.push(h.precipitation[idx]);
    precipProb.push(h.precipitation_probability[idx]);
    wind.push(Number(kmhToMph(h.wind_speed_10m[idx])));
    timeLabels.push(hourLabel(h.time[idx], i === 0));
  }

  const allTemps = temps.concat(feels);
  const tMin = Math.min(...allTemps) - 3, tMax = Math.max(...allTemps) + 3;

  const tempSvg1 = buildSvgChart({ values: temps, labels: timeLabels, lineColor: "rgb(217,33,33)", fillColor: "rgb(217,33,33)", unit: "°", yMin: tMin, yMax: tMax });
  const tempSvg2 = buildSvgChart({ values: feels, labels: timeLabels, lineColor: "rgb(27,75,154)", fillColor: "rgb(27,75,154)", unit: "°", yMin: tMin, yMax: tMax, showDots: false });
  const tempLegend = `<div class="chart-legend"><span class="legend-item"><span class="legend-swatch" style="background:rgb(217,33,33)"></span> Temperature</span><span class="legend-item"><span class="legend-swatch" style="background:rgb(27,75,154)"></span> Feels Like</span></div>`;
  const tempChartHtml = buildInteractiveChart(
    `<div class="chart-stack">${tempSvg1}${tempSvg2}</div>`,
    [
      { values: temps, labels: timeLabels, color: "rgb(217,33,33)", unit: "°F", yMin: tMin, yMax: tMax, name: "Temp" },
      { values: feels, labels: timeLabels, color: "rgb(27,75,154)", unit: "°F", yMin: tMin, yMax: tMax, name: "Feels" },
    ],
    tempLegend
  );
  const tempCard = buildCard(buildTag(icon("therm", 14, "#fff") + " Temperature (24h)"), tempChartHtml);

  const precipSvg = buildSvgChart({ values: precipProb, labels: timeLabels, lineColor: "rgb(27,75,154)", fillColor: "rgb(27,75,154)", bars: precip, barColor: "rgba(27,75,154,0.3)", unit: "%", yMin: 0, yMax: 100 });
  const precipLegend = `<div class="chart-legend"><span class="legend-item"><span class="legend-swatch" style="background:rgb(27,75,154)"></span> Probability (%)</span><span class="legend-item"><span class="legend-swatch" style="background:rgba(27,75,154,0.3)"></span> Amount (bars)</span></div>`;
  const precipChartHtml = buildInteractiveChart(
    precipSvg,
    [{ values: precipProb, labels: timeLabels, color: "rgb(27,75,154)", unit: "%", yMin: 0, yMax: 100, name: "Prob" }],
    precipLegend
  );
  const precipCard = buildCard(buildTag(icon("rain", 14, "#fff") + " Precipitation (24h)"), precipChartHtml);

  const wMin = 0, wMax = Math.max(...wind) + 3 || 10;
  const windSvg = buildSvgChart({ values: wind, labels: timeLabels, lineColor: "#1A1A1A", fillColor: "#1A1A1A", unit: " mph", yMin: wMin, yMax: wMax });
  const windChartHtml = buildInteractiveChart(
    windSvg,
    [{ values: wind, labels: timeLabels, color: "#1A1A1A", unit: " mph", yMin: wMin, yMax: wMax, name: "Wind" }]
  );
  const windCard = buildCard(buildTag(icon("wind", 14, "#fff") + " Wind Speed (24h)"), windChartHtml);

  return tempCard + precipCard + windCard;
}

/* ============================================================
   RENDER — Details, Solar, Forecast, Alerts
   ============================================================ */

function buildCurrentConditions(w) {
  const c = w.current, d = w.daily, h = w.hourly;
  const hi = new Date().getHours(), dp = dewPt(c.temperature_2m, c.relative_humidity_2m);

  const tempCard = buildCard(buildTag(icon("therm", 14, "#fff") + " Temperature &amp; Comfort"),
    buildDataRow(icon("therm"), "Temperature", `${cToF(c.temperature_2m)}°F`, true) +
    buildDataRow(icon("therm"), "Feels Like", `${cToF(c.apparent_temperature)}°F`, true) +
    buildDataRow(icon("drop"), "Dew Point", `${cToF(dp)}°F`) +
    buildDataRow(icon("drop"), "Relative Humidity", `${c.relative_humidity_2m}%`) +
    buildDataRow(icon("heart"), "Comfort Level", comfort(c.temperature_2m, c.relative_humidity_2m)) +
    buildDataRow(icon("sun"), "Day / Night", c.is_day ? "Daytime" : "Nighttime") +
    buildDataRow(icon("arrow"), "Today's High", `${cToF(d.temperature_2m_max[0])}°F`) +
    buildDataRow(icon("arrowDn"), "Today's Low", `${cToF(d.temperature_2m_min[0])}°F`) +
    buildDataRow(icon("therm"), "Feels Like Range", `${cToF(d.apparent_temperature_max[0])}° / ${cToF(d.apparent_temperature_min[0])}°`));

  const gf = c.wind_speed_10m > 0 ? (c.wind_gusts_10m / c.wind_speed_10m).toFixed(1) : "—";
  const windCard = buildCard(buildTag(icon("wind", 14, "#fff") + " Wind"),
    buildDataRow(icon("wind"), "Sustained Speed", `${kmhToMph(c.wind_speed_10m)} mph`, true) +
    buildDataRow(icon("wind"), "Wind Gusts", `${kmhToMph(c.wind_gusts_10m)} mph`, true) +
    buildDataRow(icon("compass"), "Direction", `${c.wind_direction_10m}° ${degDir(c.wind_direction_10m)}`) +
    buildDataRow(icon("activity"), "Gust Factor", `${gf}x`) +
    buildDataRow(icon("wind"), "Beaufort Scale", beaufort(c.wind_speed_10m)) +
    buildDataRow(icon("wind"), "Today's Max Wind", `${kmhToMph(d.wind_speed_10m_max[0])} mph`) +
    buildDataRow(icon("wind"), "Today's Max Gusts", `${kmhToMph(d.wind_gusts_10m_max[0])} mph`) +
    buildNote(icon("wind"), `Wind is blowing from the ${degDir(c.wind_direction_10m)} at ${kmhToMph(c.wind_speed_10m)} mph with gusts up to ${kmhToMph(c.wind_gusts_10m)} mph.`));

  let totalP = 0, maxPhr = 0, maxPval = 0;
  for (let i = 0; i < 24; i++) { const idx = hi + i; if (idx < h.precipitation.length) { totalP += h.precipitation[idx]; if (h.precipitation[idx] > maxPval) { maxPval = h.precipitation[idx]; maxPhr = idx; } } }
  let pRows = buildDataRow(icon("rain"), "Current Precipitation", `${mmToIn(c.precipitation)} in`, true) +
    buildDataRow(icon("rain"), "Current Rain", `${mmToIn(c.rain)} in`) +
    buildDataRow(icon("snow"), "Current Snowfall", `${mmToIn(c.snowfall * 10)} in`) + buildDivider() +
    buildDataRow(icon("rain"), "Next 24h Total", `${mmToIn(totalP)} in`, true) +
    buildDataRow(icon("rain"), "Today's Total", `${mmToIn(d.precipitation_sum[0])} in`) +
    buildDataRow(icon("rain"), "Today's Probability", `${d.precipitation_probability_max[0]}%`) +
    buildDataRow(icon("clock"), "Today's Precip Hours", `${d.precipitation_hours[0]}h`);
  if (totalP > 0) pRows += buildNote(icon("alert"), `Peak precipitation expected around ${fmtTime(h.time[maxPhr])} (${mmToIn(maxPval)} in).`);
  const precipCard = buildCard(buildTag(icon("rain", 14, "#fff") + " Precipitation"), pRows);

  return tempCard + windCard + precipCard;
}

function buildSolarUV(w) {
  const d = w.daily, h = w.hourly, hi = new Date().getHours();
  const sr = new Date(d.sunrise[0]), ss = new Date(d.sunset[0]), dayMin = (ss - sr) / 1000 / 60;
  const uvNow = h.uv_index[hi] !== undefined ? h.uv_index[hi] : d.uv_index_max[0];

  const sunCard = buildCard(buildTag(icon("sunrise", 14, "#fff") + " Sunrise &amp; Sunset"),
    buildDataRow(icon("sunrise"), "Sunrise", fmtTime(d.sunrise[0]), true) +
    buildDataRow(icon("sunset"), "Sunset", fmtTime(d.sunset[0]), true) +
    buildDataRow(icon("clock"), "Total Daylight", `${Math.floor(dayMin / 60)}h ${Math.round(dayMin % 60)}m`) +
    buildDataRow(icon("clock"), "Night Length", `${Math.floor((1440 - dayMin) / 60)}h ${Math.round((1440 - dayMin) % 60)}m`));

  const uvTip = uvNow <= 2 ? "No protection required. Safe for outdoor activities."
    : uvNow <= 5 ? "Wear sunscreen and sunglasses for extended outdoor exposure."
    : uvNow <= 7 ? "Reduce sun exposure between 10am–4pm. Sunscreen and hat recommended."
    : "Minimize sun exposure. Sunscreen, hat, and protective clothing essential.";
  const uvCard = buildCard(buildTag(icon("uv", 14, "#fff") + " UV Index"),
    buildDataRow(icon("uv"), "Current UV Index", `${uvNow}`, true) +
    buildDataRow(icon("uv"), "Current UV Rating", uvLabel(uvNow), true) +
    buildDataRow(icon("uv"), "Today's Maximum UV", `${d.uv_index_max[0]} (${uvLabel(d.uv_index_max[0])})`) +
    buildNote(icon("alert"), uvTip));

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
    const pNote = d.precipitation_hours[i] > 0 ? `<div class="fc-precip-note">${icon("clock", 13)} Precipitation expected for ~${d.precipitation_hours[i]} hours</div>` : "";

    html += `<div class="wx-card"><div class="card-accent ${color}"></div><div class="card-body">
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
      ${pNote}
    </div></div>`;
  }
  return html;
}

function buildAlerts(alerts) {
  if (!alerts || !alerts.length) return "";
  let items = "";
  for (const a of alerts) {
    const sc = (a.severity === "Extreme" || a.severity === "Severe") ? "extreme" : a.severity === "Moderate" ? "moderate" : "";
    const tr = (a.onset && a.expires) ? `${fmtTime(a.onset)} – ${fmtTime(a.expires)}` : "";
    items += `<div class="advisory-item">
      <div class="advisory-severity ${sc}">${escHtml(a.severity)} · ${escHtml(a.urgency)}</div>
      <div class="advisory-event">${icon("alert", 14)} ${escHtml(a.event)}</div>
      ${a.headline ? `<div class="advisory-headline">${escHtml(a.headline)}</div>` : ""}
      ${tr ? `<div class="advisory-time">${icon("clock", 12)} ${escHtml(tr)}</div>` : ""}
      ${a.description ? `<div class="advisory-desc">${escHtml(a.description)}${a.description.length >= 300 ? "…" : ""}</div>` : ""}
      ${a.instruction ? `<div class="advisory-instr">${escHtml(a.instruction.substring(0, 200))}${a.instruction.length >= 200 ? "…" : ""}</div>` : ""}
      <div class="advisory-source">Source: ${escHtml(a.sender)}</div>
    </div>`;
  }
  return buildCard(buildTag(icon("alert", 14, "#fff") + ` Active Advisories (${alerts.length})`), items);
}

/* ============================================================
   RENDER — Satellite Section
   ============================================================ */

function buildSatellite() {
  const color = nextColor();
  const sector = satResolvedSector;
  const sectorLabel = sector ? sector.label : '…';

  // Band buttons
  let bandBtns = '';
  for (const b of SAT_BANDS) {
    const isActive = b.id === satCurrentBand ? ' active' : '';
    bandBtns += `<button class="sat-band-btn${isActive}" data-band="${b.id}" onclick="onBandChange('${b.id}')" title="${escHtml(b.desc)}">${escHtml(b.label)}</button>`;
  }

  // Duration buttons
  let durBtns = '';
  for (const d of SAT_DURATIONS) {
    const isActive = d.id === satCurrentDuration ? ' active' : '';
    durBtns += `<button class="sat-dur-btn${isActive}" data-dur="${d.id}" onclick="onDurationChange('${d.id}')">${escHtml(d.label)}</button>`;
  }

  // Viewer link
  const viewUrl = sector ? satViewerUrl(sector, satCurrentBand) : '#';

  return `<div class="wx-card"><div class="card-accent ${color}"></div><div class="card-body sat-card-body">
    ${buildTag(icon("satellite", 14, "#fff") + ' <span id="sat-sector-label">' + escHtml(sectorLabel) + ' Sector</span> — GOES Satellite')}

    <div class="sat-controls-group">
      <div class="sat-control-label">Image type</div>
      <div class="sat-btn-row">${bandBtns}</div>
    </div>

    <div class="sat-controls-group">
      <div class="sat-control-label">Show me</div>
      <div class="sat-btn-row">${durBtns}</div>
    </div>

    <div class="sat-viewer">
      <img id="sat-image" class="sat-img" src="" alt="Satellite imagery loading…">
    </div>

    <div class="sat-player-bar">
      <button class="sat-ctrl-btn" onclick="satStepBack()" title="Step back">${icon('skipBack', 14, '#fff')}</button>
      <button class="sat-ctrl-btn" id="sat-play-btn" onclick="satTogglePlay()" title="Play/Pause">${icon('play', 14, '#fff')}</button>
      <button class="sat-ctrl-btn" onclick="satStepFwd()" title="Step forward">${icon('skipFwd', 14, '#fff')}</button>
      <input type="range" class="sat-slider" id="sat-slider" min="0" max="1" value="0" step="1" oninput="satPause(); satShowFrame(parseInt(this.value));">
      <span class="sat-counter" id="sat-counter"></span>
    </div>

    <div class="sat-meta-row">
      <span class="sat-timestamp" id="sat-timestamp">Loading…</span>
      <a href="${viewUrl}" target="_blank" rel="noopener" class="sat-noaa-link">NOAA viewer →</a>
    </div>
  </div></div>`;
}

/* ============================================================
   RENDER — Apply filters
   ============================================================ */

function applyFilters() {
  syncFilterButtons();
  if (!weatherData) return;
  const wrapper = document.getElementById("content-wrapper");
  if (!wrapper) return;

  // Stop any running satellite animation before rebuilding
  satStop();

  resetColors();
  chartIdCounter = 0;
  let html = "";
  const showAll = activeSection === null;

  if (showAll) {
    html += buildSection(icon("sun") + " Overview");
    if (alertsData.length > 0) html += buildAlerts(alertsData);
    html += buildHero(weatherData);
  }
  if (showAll || activeSection === "Hourly") {
    html += buildHourly(weatherData);
    html += buildSection(icon("chart") + " 24-Hour Trends");
    html += buildGraphs(weatherData);
  }
  if (showAll || activeSection === "Details") {
    html += buildSection(icon("therm") + " Current Conditions");
    html += buildCurrentConditions(weatherData);
    html += buildSection(icon("sun") + " Solar &amp; UV");
    html += buildSolarUV(weatherData);
  }
  if (showAll || activeSection === "Satellite") {
    html += buildSection(icon("satellite") + " GOES Satellite Imagery");
    html += buildSatellite();
  }
  if (showAll || activeSection === "Forecast") {
    html += buildSection(icon("cal") + " 7-Day Forecast");
    html += buildForecast(weatherData);
  }

  wrapper.innerHTML = html;
  bindChartInteractions();

  // Load satellite if the section is visible
  if (showAll || activeSection === "Satellite") {
    satLoad();
  }
}

/* ============================================================
   LOADING UI
   ============================================================ */

function updateLoading(status) {
  const el = document.getElementById("loading-status");
  if (el) el.textContent = status;
}

function hideLoading() {
  const ld = document.getElementById("loading-overlay");
  if (ld) { ld.classList.add("hidden"); setTimeout(() => ld.style.display = "none", 500); }
}

function freezeLoading() {
  const la = document.getElementById("loading-accent");
  if (la) { la.style.animation = "none"; la.style.background = "rgb(217, 33, 33)"; }
}

function showZipFallback(statusText) {
  updateLoading(statusText);
  freezeLoading();
  const row = document.getElementById("loading-zip-row");
  if (row) row.classList.add("visible");
  setTimeout(() => {
    const inp = document.getElementById("zip-input");
    if (inp) inp.focus();
  }, 400);
}

async function handleZipSubmit() {
  const inp = document.getElementById("zip-input");
  const btn = document.getElementById("zip-go");
  if (!inp || !btn) return;

  const zip = inp.value.trim();
  if (!/^\d{5}$/.test(zip)) {
    inp.style.borderColor = "rgb(217,33,33)";
    inp.focus();
    return;
  }

  inp.style.borderColor = "";
  btn.disabled = true;
  btn.textContent = "…";
  updateLoading("Looking up " + zip);

  const la = document.getElementById("loading-accent");
  if (la) { la.style.animation = ""; la.style.background = ""; }

  try {
    const geo = await geocodeZip(zip);
    writeGeoCache(geo.lat, geo.lon);
    await fetchAndRender(geo.lat, geo.lon);
  } catch (e) {
    freezeLoading();
    updateLoading("Could not find that ZIP code");
    btn.disabled = false;
    btn.textContent = "Go →";
    inp.value = "";
    inp.focus();
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

  if (force) { try { localStorage.removeItem(CACHE_KEY); } catch {} }

  if (!force) {
    const cached = readCache();
    if (cached) {
      weatherData = cached.weather; locationData = cached.location;
      alertsData = cached.alerts || []; lastUpdatedAt = cached.savedAt;
      // Resolve sector from geo cache
      const geo = readGeoCache();
      if (geo) satResolvedSector = resolveSector(geo.lat, geo.lon);
      renderHeader(); renderLocationBar(); renderLastUpdated(); renderFilters(); applyFilters(); hideLoading();
      isLoading = false; if (refreshBtn) refreshBtn.disabled = false; return;
    }
  }

  const geo = readGeoCache();
  if (geo) {
    satResolvedSector = resolveSector(geo.lat, geo.lon);
    updateLoading("Fetching weather data");
    await fetchAndRender(geo.lat, geo.lon);
    isLoading = false; if (refreshBtn) refreshBtn.disabled = false; return;
  }

  if (!navigator.geolocation) {
    showZipFallback("Location not supported — enter a ZIP code");
    isLoading = false; if (refreshBtn) refreshBtn.disabled = false; return;
  }

  updateLoading("Requesting location access");

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      updateLoading("Fetching weather data");
      writeGeoCache(pos.coords.latitude, pos.coords.longitude);
      satResolvedSector = resolveSector(pos.coords.latitude, pos.coords.longitude);
      await fetchAndRender(pos.coords.latitude, pos.coords.longitude);
      isLoading = false; if (refreshBtn) refreshBtn.disabled = false;
    },
    () => {
      showZipFallback("Location denied — enter a ZIP code");
      isLoading = false; if (refreshBtn) refreshBtn.disabled = false;
    }
  );
}

async function fetchAndRender(lat, lon) {
  try {
    updateLoading("Fetching weather data");
    satResolvedSector = resolveSector(lat, lon);
    const [weather, loc] = await Promise.all([getWeather(lat, lon), getCityName(lat, lon)]);
    weatherData = weather; locationData = loc; alertsData = [];
    writeCache(weather, loc, []);
    renderHeader(); renderLocationBar(); renderLastUpdated(); renderFilters(); applyFilters(); hideLoading();
    getAlerts(lat, lon).then(alerts => { if (alerts && alerts.length > 0) { alertsData = alerts; writeCache(weather, loc, alerts); applyFilters(); } });
  } catch (e) {
    freezeLoading();
    updateLoading("Something went wrong");
  }
}

/* ============================================================
   INIT
   ============================================================ */

document.addEventListener("DOMContentLoaded", () => {
  renderHeader(); renderFilters();
  document.getElementById("refresh-btn")?.addEventListener("click", () => loadWeather(true));

  const zipGo  = document.getElementById("zip-go");
  const zipInp = document.getElementById("zip-input");
  if (zipGo) zipGo.addEventListener("click", handleZipSubmit);
  if (zipInp) zipInp.addEventListener("keydown", e => { if (e.key === "Enter") handleZipSubmit(); });

  loadWeather();
});