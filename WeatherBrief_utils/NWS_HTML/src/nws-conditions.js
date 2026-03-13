/**
 * nws-conditions.js — Current observation from nearest station.
 * Depends on: nws-core.js
 */

(function (ns) {
  'use strict';

  ns.conditions = {};

  /**
   * Fetch the latest observation.
   * @returns {Promise<Object>} parsed conditions object
   */
  ns.conditions.fetch = async function () {
    ns.ensureReady();
    const stationsData = await ns.apiFetch(ns.location.stationsUrl);
    const stationId = stationsData.features[0].properties.stationIdentifier;
    const obs = await ns.apiFetch(ns.API_BASE + '/stations/' + stationId + '/observations/latest');
    const p = obs.properties;

    return {
      raw: p,
      station: stationId,
      description: p.textDescription || '',
      timestamp: p.timestamp,
      temperature: p.temperature && p.temperature.value !== null
        ? { c: p.temperature.value, f: ns.cToF(p.temperature.value) }
        : null,
      dewpoint: p.dewpoint && p.dewpoint.value !== null
        ? { c: p.dewpoint.value, f: ns.cToF(p.dewpoint.value) }
        : null,
      humidity: p.relativeHumidity ? +p.relativeHumidity.value.toFixed(0) : null,
      wind: {
        speedKmh: p.windSpeed ? p.windSpeed.value : null,
        speedMph: ns.kmhToMph(p.windSpeed ? p.windSpeed.value : null),
        direction: p.windDirection ? p.windDirection.value : null,
        gustKmh: p.windGust ? p.windGust.value : null,
        gustMph: ns.kmhToMph(p.windGust ? p.windGust.value : null),
      },
      barometer: {
        pa: p.barometricPressure ? p.barometricPressure.value : null,
        hpa: ns.paToHpa(p.barometricPressure ? p.barometricPressure.value : null),
        inHg: ns.paToInHg(p.barometricPressure ? p.barometricPressure.value : null),
      },
      visibility: {
        m: p.visibility ? p.visibility.value : null,
        mi: ns.mToMi(p.visibility ? p.visibility.value : null),
      },
      heatIndex: p.heatIndex && p.heatIndex.value !== null
        ? { c: p.heatIndex.value, f: ns.cToF(p.heatIndex.value) }
        : null,
      windChill: p.windChill && p.windChill.value !== null
        ? { c: p.windChill.value, f: ns.cToF(p.windChill.value) }
        : null,
    };
  };

  /**
   * Render current conditions into a target element.
   * @param {string|HTMLElement} target
   */
  ns.conditions.render = async function (target) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return;
    el.classList.add('nws-conditions');
    el.innerHTML = '<div class="nws-loading">Loading conditions…</div>';

    try {
      const c = await ns.conditions.fetch();
      const temp = c.temperature ? c.temperature.f + '°F' : '—';
      const tempC = c.temperature ? c.temperature.c.toFixed(1) + '°C' : '';
      el.innerHTML =
        '<div class="nws-cond-main">' +
          '<div class="nws-cond-temp">' + temp + '</div>' +
          '<div class="nws-cond-tempc">' + tempC + '</div>' +
          '<div class="nws-cond-desc">' + c.description + '</div>' +
        '</div>' +
        '<div class="nws-cond-grid">' +
          _cell('Humidity', c.humidity !== null ? c.humidity + '%' : '—') +
          _cell('Wind', c.wind.speedMph !== null ? c.wind.speedMph + ' mph' : 'Calm') +
          _cell('Gusts', c.wind.gustMph !== null ? c.wind.gustMph + ' mph' : '—') +
          _cell('Dewpoint', c.dewpoint ? c.dewpoint.f + '°F' : '—') +
          _cell('Barometer', c.barometer.inHg ? c.barometer.inHg + ' inHg' : '—') +
          _cell('Visibility', c.visibility.mi ? c.visibility.mi + ' mi' : '—') +
          _cell('Heat Index', c.heatIndex ? c.heatIndex.f + '°F' : '—') +
          _cell('Wind Chill', c.windChill ? c.windChill.f + '°F' : '—') +
        '</div>' +
        '<div class="nws-cond-meta">Station ' + c.station + ' · ' + new Date(c.timestamp).toLocaleString() + '</div>';
    } catch (err) {
      el.innerHTML = '<div class="nws-error">' + err.message + '</div>';
    }
  };

  function _cell(label, value) {
    return '<div class="nws-cond-cell"><span class="nws-cond-label">' + label + '</span><span class="nws-cond-value">' + value + '</span></div>';
  }

})(NWS);
