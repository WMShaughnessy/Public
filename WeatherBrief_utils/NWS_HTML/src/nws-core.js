/**
 * nws-core.js — Constants, shared fetch wrapper, location utilities.
 * All other modules depend on this file.
 */

var NWS = NWS || {};

(function (ns) {
  'use strict';

  // ── Public API Endpoints ──────────────────────────────────────
  ns.API_BASE   = 'https://api.weather.gov';
  ns.GOES_CDN   = 'https://cdn.star.nesdis.noaa.gov';
  ns.GOES_PAGE  = 'https://www.star.nesdis.noaa.gov/GOES';
  ns.RADAR_BASE = 'https://radar.weather.gov';

  // NWS asks for a contact string in User-Agent
  ns.USER_AGENT = '(NWSWeatherLib/1.0, github.com/user/nws-weather-lib)';

  // ── Shared fetch wrapper ──────────────────────────────────────
  ns.apiFetch = async function (url) {
    const res = await fetch(url, {
      headers: {
        'User-Agent': ns.USER_AGENT,
        'Accept': 'application/geo+json',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('NWS ' + res.status + ' from ' + url + ' — ' + body.slice(0, 200));
    }
    return res.json();
  };

  // ── Location state (shared across modules) ────────────────────
  ns.location = {
    lat: null,
    lon: null,
    pointData: null,       // raw /points response properties
    forecastUrl: null,
    forecastHourlyUrl: null,
    forecastGridDataUrl: null,
    stationsUrl: null,
    gridId: null,
    gridX: null,
    gridY: null,
    radarStation: null,
    countyZone: null,
    forecastZone: null,
    fireZone: null,
    ready: false,
  };

  /**
   * Resolve NWS point metadata for a lat/lon pair.
   * Populates NWS.location with all grid/station/zone info.
   */
  ns.resolvePoint = async function (lat, lon) {
    const loc = ns.location;
    loc.lat = parseFloat(lat);
    loc.lon = parseFloat(lon);
    loc.ready = false;

    const url = ns.API_BASE + '/points/' + loc.lat.toFixed(4) + ',' + loc.lon.toFixed(4);
    const data = await ns.apiFetch(url);
    const p = data.properties;

    loc.pointData          = p;
    loc.forecastUrl        = p.forecast;
    loc.forecastHourlyUrl  = p.forecastHourly;
    loc.forecastGridDataUrl = p.forecastGridData;
    loc.stationsUrl        = p.observationStations;
    loc.gridId             = p.gridId;
    loc.gridX              = p.gridX;
    loc.gridY              = p.gridY;
    loc.radarStation       = p.radarStation;
    loc.countyZone         = p.county;
    loc.forecastZone       = p.forecastZone;
    loc.fireZone           = p.fireWeatherZone;
    loc.ready              = true;

    // fire a custom event so UI can react
    if (typeof CustomEvent !== 'undefined') {
      document.dispatchEvent(new CustomEvent('nws:ready', { detail: loc }));
    }

    return loc;
  };

  /**
   * Use browser geolocation, then resolve the NWS point.
   * @returns {Promise<Object>} NWS.location
   */
  ns.locate = function () {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          ns.resolvePoint(pos.coords.latitude, pos.coords.longitude)
            .then(resolve)
            .catch(reject);
        },
        reject,
        { enableHighAccuracy: false, timeout: 12000 }
      );
    });
  };

  ns.ensureReady = function () {
    if (!ns.location.ready) throw new Error('NWS: call NWS.locate() or NWS.resolvePoint() first');
  };

  // ── Unit helpers ──────────────────────────────────────────────
  ns.cToF   = function (c) { return c !== null && c !== undefined ? +(c * 9 / 5 + 32).toFixed(1) : null; };
  ns.kmhToMph = function (kmh) { return kmh !== null ? +(kmh * 0.621371).toFixed(1) : null; };
  ns.mToMi  = function (m) { return m !== null ? +(m / 1609.34).toFixed(1) : null; };
  ns.paToHpa = function (pa) { return pa !== null ? +(pa / 100).toFixed(1) : null; };
  ns.paToInHg = function (pa) { return pa !== null ? +(pa / 3386.39).toFixed(2) : null; };

})(NWS);
