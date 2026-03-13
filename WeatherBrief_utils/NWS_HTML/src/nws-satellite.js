/**
 * nws-satellite.js — GOES sector satellite imagery with built-in animation.
 * Depends on: nws-core.js
 *
 * CDN structure (directory listing is browsable):
 *   https://cdn.star.nesdis.noaa.gov/GOES19/ABI/SECTOR/ne/GEOCOLOR/
 *     latest.jpg
 *     20260712351_GOES19-ABI-ne-GEOCOLOR-1200x1200.jpg
 *     20260712351_GOES19-ABI-ne-GEOCOLOR-600x600.jpg
 *
 * Animation approach:
 *   1. Fetch the CDN directory listing (plain HTML index)
 *   2. Parse filenames matching the desired resolution
 *   3. Take the last N frames
 *   4. Cycle through them with a JS interval
 */

(function (ns) {
  'use strict';

  ns.satellite = {};

  // ── Band catalog ──────────────────────────────────────────
  ns.satellite.SECTOR_BANDS = [
    { id: 'GEOCOLOR',                label: 'GeoColor',              desc: 'True color day / IR night' },
    { id: 'DayNightCloudMicroCombo', label: 'Day/Night Cloud Micro', desc: 'Cloud reflectance / fog' },
    { id: 'Sandwich',                label: 'Sandwich RGB',          desc: 'Bands 3 & 13 combo' },
    { id: 'AirMass',                 label: 'Air Mass RGB',          desc: 'IR + water vapor composite' },
    { id: 'FireTemperature',         label: 'Fire Temperature',      desc: 'Fire identification' },
    { id: 'Dust',                    label: 'Dust RGB',              desc: 'Dust detection' },
    { id: '02',                      label: 'Band 2 Visible',       desc: '0.64 µm red' },
    { id: '09',                      label: 'Band 9 WV Mid',        desc: '6.9 µm water vapor' },
    { id: '13',                      label: 'Band 13 IR',           desc: '10.3 µm longwave' },
    { id: '14',                      label: 'Band 14 IR',           desc: '11.2 µm longwave' },
  ];

  // ── Sectors ───────────────────────────────────────────────
  var SECTORS = [
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
  ns.satellite.SECTORS = SECTORS;

  ns.satellite.resolveSector = function (lat, lon) {
    for (var i = 0; i < SECTORS.length; i++) {
      var s = SECTORS[i];
      if (lat >= s.latMin && lat <= s.latMax && lon >= s.lonMin && lon <= s.lonMax) return s;
    }
    return { id: 'ne', sat: 'GOES19', p: 'G19', label: 'Northeast' };
  };

  // ── URL builders ──────────────────────────────────────────

  /** CDN directory URL for a sector+band */
  ns.satellite.cdnDir = function (opts) {
    opts = opts || {};
    var band = opts.band || 'GEOCOLOR';
    var info = opts._sector || ns.satellite.resolveSector(ns.location.lat, ns.location.lon);
    return ns.GOES_CDN + '/' + info.sat + '/ABI/SECTOR/' + info.id + '/' + band + '/';
  };

  /** Static latest image */
  ns.satellite.latestUrl = function (opts) {
    return ns.satellite.cdnDir(opts) + 'latest.jpg';
  };

  /** NOAA viewer page for a sector (opens in new tab) */
  ns.satellite.viewerUrl = function (opts) {
    opts = opts || {};
    var band = opts.band || 'GEOCOLOR';
    var info = opts._sector || ns.satellite.resolveSector(ns.location.lat, ns.location.lon);
    return ns.GOES_PAGE + '/sector_band.php?sat=' + info.p + '&sector=' + info.id + '&band=' + band + '&length=12';
  };

  // ── Timestamp helper ──────────────────────────────────────

  /**
   * Parse a CDN filename timestamp and return a 12-hour formatted string.
   * Filename pattern: 20260712351_GOES19-ABI-ne-GEOCOLOR-1200x1200.jpg
   * Timestamp portion: YYYYDDDHHMM (year, day-of-year, hour, minute in UTC)
   *
   * @param {string} filename
   * @returns {string|null}  e.g. "3/13/2026 7:51 PM UTC" or null if unparseable
   */
  function parseFrameTimestamp(filename) {
    var ts = filename.split('_')[0];
    if (!ts || ts.length < 11) return null;

    var yr  = parseInt(ts.slice(0, 4), 10);
    var doy = parseInt(ts.slice(4, 7), 10);
    var hr  = parseInt(ts.slice(7, 9), 10);
    var mn  = ts.slice(9, 11);

    // Convert day-of-year to month/day
    var d = new Date(Date.UTC(yr, 0, doy, hr, parseInt(mn, 10)));

    // Format in 12-hour local style
    var month = d.getUTCMonth() + 1;
    var day   = d.getUTCDate();
    var year  = d.getUTCFullYear();
    var h     = d.getUTCHours();
    var ampm  = h >= 12 ? 'PM' : 'AM';
    var h12   = h % 12;
    if (h12 === 0) h12 = 12;

    return month + '/' + day + '/' + year + ' ' + h12 + ':' + mn + ' ' + ampm + ' UTC';
  }

  // ── Fetch frames from CDN directory listing ───────────────

  /**
   * Fetch the CDN directory and parse image filenames.
   * Falls back to trying alternate sizes if exact match fails.
   * @param {Object} opts  { band, size, maxFrames, _sector }
   * @returns {Promise<string[]>}  array of full image URLs, chronological
   */
  ns.satellite.fetchFrames = async function (opts) {
    opts = opts || {};
    var size = opts.size || '1200x1200';
    var maxFrames = opts.maxFrames || 40;
    var dirUrl = ns.satellite.cdnDir(opts);

    var res = await fetch(dirUrl);
    if (!res.ok) throw new Error('CDN directory fetch failed: ' + res.status);
    var html = await res.text();

    // Parse filenames from the directory listing HTML
    var regex = new RegExp('href="([^"]*' + size.replace('x', 'x') + '\\.jpg)"', 'gi');
    var frames = [];
    var match;
    while ((match = regex.exec(html)) !== null) {
      frames.push(dirUrl + match[1]);
    }

    // If no frames found at requested size, try common fallback sizes
    if (frames.length === 0) {
      var fallbackSizes = ['1200x1200', '600x600', '1800x1800', '2400x2400', '3600x3600'];
      for (var s = 0; s < fallbackSizes.length; s++) {
        if (fallbackSizes[s] === size) continue;
        var fbRegex = new RegExp('href="([^"]*' + fallbackSizes[s] + '\\.jpg)"', 'gi');
        while ((match = fbRegex.exec(html)) !== null) {
          frames.push(dirUrl + match[1]);
        }
        if (frames.length > 0) break;
      }
    }

    // Sort chronologically (filenames start with timestamp) and take last N
    frames.sort();
    if (frames.length > maxFrames) {
      frames = frames.slice(frames.length - maxFrames);
    }
    return frames;
  };

  // ── Animation player ─────────────────────────────────────

  /**
   * Render an animated satellite viewer with play/pause, scrub, speed/frame controls.
   *
   * @param {string|HTMLElement} target
   * @param {Object} opts  { band, size, maxFrames, interval, showLoopControls }
   * @returns {Promise<Object>}  controller { play, pause, destroy }
   */
  ns.satellite.renderAnimated = async function (target, opts) {
    ns.ensureReady();
    opts = opts || {};
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return;
    el.classList.add('nws-satellite');

    var band = opts.band || 'GEOCOLOR';
    var interval = opts.interval || 200;
    var maxFrames = opts.maxFrames || 30;
    var showLoopControls = opts.showLoopControls !== false;
    var bandMeta = ns.satellite.SECTOR_BANDS.find(function (b) { return b.id === band; }) || { label: band };
    var sector = ns.satellite.resolveSector(ns.location.lat, ns.location.lon);
    var viewUrl = ns.satellite.viewerUrl(Object.assign({}, opts, { _sector: sector }));

    var loopControlsHtml = '';
    if (showLoopControls) {
      loopControlsHtml =
        '<div class="nws-sat-loop-controls">' +
          '<label class="nws-loop-label">Frames <input class="nws-loop-input" type="number" data-ctrl="frames" min="5" max="120" value="' + maxFrames + '" step="5"></label>' +
          '<label class="nws-loop-label">Speed <select class="nws-loop-select" data-ctrl="speed">' +
            '<option value="500"' + (interval === 500 ? ' selected' : '') + '>0.5×</option>' +
            '<option value="400"' + (interval === 400 ? ' selected' : '') + '>0.75×</option>' +
            '<option value="200"' + (interval === 200 ? ' selected' : '') + '>1×</option>' +
            '<option value="100"' + (interval === 100 ? ' selected' : '') + '>2×</option>' +
            '<option value="50"' + (interval === 50 ? ' selected' : '') + '>4×</option>' +
          '</select></label>' +
          '<button class="nws-loop-reload" data-ctrl="reload" title="Reload with new settings">↻ Reload</button>' +
        '</div>';
    }

    el.innerHTML =
      '<div class="nws-sat-header">' +
        '<span>' + sector.label + ' — ' + bandMeta.label + '</span>' +
        '<a href="' + viewUrl + '" target="_blank" rel="noopener">NOAA viewer →</a>' +
      '</div>' +
      loopControlsHtml +
      '<div class="nws-sat-player">' +
        '<img class="nws-sat-img nws-sat-img-native" src="' + ns.satellite.latestUrl(Object.assign({}, opts, { _sector: sector })) + '" alt="Loading…">' +
        '<div class="nws-sat-controls">' +
          '<button class="nws-sat-btn" data-action="play" title="Play/Pause">▶</button>' +
          '<button class="nws-sat-btn nws-sat-step-btn" data-action="stepback" title="Step back">⏮</button>' +
          '<button class="nws-sat-btn nws-sat-step-btn" data-action="stepfwd" title="Step forward">⏭</button>' +
          '<input class="nws-sat-slider" type="range" min="0" max="1" value="0" step="1">' +
          '<span class="nws-sat-timestamp">Loading frames…</span>' +
        '</div>' +
      '</div>';

    var img = el.querySelector('.nws-sat-img');
    var slider = el.querySelector('.nws-sat-slider');
    var btn = el.querySelector('[data-action="play"]');
    var stepBackBtn = el.querySelector('[data-action="stepback"]');
    var stepFwdBtn = el.querySelector('[data-action="stepfwd"]');
    var tsLabel = el.querySelector('.nws-sat-timestamp');

    // Fetch frames
    var frames;
    try {
      frames = await ns.satellite.fetchFrames(Object.assign({}, opts, { _sector: sector }));
    } catch (e) {
      tsLabel.textContent = 'Could not load frames — showing latest';
      return;
    }

    if (frames.length === 0) {
      tsLabel.textContent = 'No frames available';
      return;
    }

    // Preload frames
    frames.forEach(function (url) { var i = new Image(); i.src = url; });

    slider.max = frames.length - 1;
    slider.value = frames.length - 1;

    var currentFrame = frames.length - 1;
    var playing = false;
    var timer = null;

    function showFrame(idx) {
      currentFrame = idx;
      img.src = frames[idx];
      slider.value = idx;
      var fname = frames[idx].split('/').pop();
      var ts12 = parseFrameTimestamp(fname);
      if (ts12) {
        tsLabel.textContent = ts12 + '  (' + (idx + 1) + '/' + frames.length + ')';
      } else {
        tsLabel.textContent = 'Frame ' + (idx + 1) + '/' + frames.length;
      }
    }

    function play() {
      playing = true;
      btn.textContent = '⏸';
      timer = setInterval(function () {
        currentFrame = (currentFrame + 1) % frames.length;
        showFrame(currentFrame);
      }, interval);
    }

    function pause() {
      playing = false;
      btn.textContent = '▶';
      clearInterval(timer);
    }

    btn.addEventListener('click', function () { playing ? pause() : play(); });

    stepBackBtn.addEventListener('click', function () {
      pause();
      var idx = currentFrame - 1;
      if (idx < 0) idx = frames.length - 1;
      showFrame(idx);
    });

    stepFwdBtn.addEventListener('click', function () {
      pause();
      var idx = (currentFrame + 1) % frames.length;
      showFrame(idx);
    });

    slider.addEventListener('input', function () { pause(); showFrame(parseInt(slider.value)); });

    // Wire reload button if present
    if (showLoopControls) {
      var reloadBtn = el.querySelector('[data-ctrl="reload"]');
      var framesInput = el.querySelector('[data-ctrl="frames"]');
      var speedSelect = el.querySelector('[data-ctrl="speed"]');

      if (reloadBtn) {
        reloadBtn.addEventListener('click', function () {
          pause();
          var newMaxFrames = parseInt(framesInput.value) || maxFrames;
          var newInterval = parseInt(speedSelect.value) || interval;
          el.innerHTML = '';
          ns.satellite.renderAnimated(el, Object.assign({}, opts, {
            band: band,
            maxFrames: newMaxFrames,
            interval: newInterval,
          }));
        });
      }
    }

    // Start on last frame, auto-play
    showFrame(frames.length - 1);
    play();

    return { play: play, pause: pause, destroy: function () { pause(); el.innerHTML = ''; } };
  };

  // ── Band switcher (tabs + animated player) ────────────────

  ns.satellite.renderBandSwitcher = function (target, opts) {
    ns.ensureReady();
    opts = opts || {};
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return;

    var bands = ns.satellite.SECTOR_BANDS;

    var btns = '';
    bands.forEach(function (b, i) {
      btns += '<button class="nws-band-btn' + (i === 0 ? ' active' : '') + '" data-band="' + b.id + '" title="' + b.desc + '">' + b.label + '</button>';
    });

    el.innerHTML =
      '<div class="nws-band-tabs">' + btns + '</div>' +
      '<div class="nws-sat-player-container"></div>';

    var container = el.querySelector('.nws-sat-player-container');
    var currentController = null;

    function loadBand(bandId) {
      if (currentController) currentController.destroy();
      container.innerHTML = '';
      var playerEl = document.createElement('div');
      container.appendChild(playerEl);
      ns.satellite.renderAnimated(playerEl, Object.assign({}, opts, { band: bandId }))
        .then(function (ctrl) { currentController = ctrl; });
    }

    el.querySelectorAll('.nws-band-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        el.querySelectorAll('.nws-band-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        loadBand(btn.getAttribute('data-band'));
      });
    });

    loadBand(bands[0].id);
  };

})(NWS);