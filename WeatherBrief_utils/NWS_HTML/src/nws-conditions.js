/**
 * nws-conditions.js — Current observation from nearest station.
 * Depends on: nws-core.js
 */

(function (ns) {
  'use strict';

  ns.conditions = {};

  /**
   * Read a value out of an NWS measurement wrapper.
   *
   * Every observed property arrives as {value, unitCode, qualityControl}, and
   * the API routinely reports an unavailable reading as {value: null}. Testing
   * the wrapper alone says only that the property was mentioned, not that it
   * was measured -- which is how one missing humidity reading used to throw
   * partway through the parse and take every other field down with it.
   */
  function _val(m) {
    if (!m) return null;
    var v = m.value;
    return (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) ? null : v;
  }

  function _round(v, digits) {
    return v === null ? null : +v.toFixed(digits);
  }

  function _esc(str) {
    return String(str === null || str === undefined ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Fetch the latest observation.
   * @returns {Promise<Object>} parsed conditions object
   */
  ns.conditions.fetch = async function () {
    ns.ensureReady();
    const stationsData = await ns.apiFetch(ns.location.stationsUrl);
    // Offshore points and parts of the territories resolve to no station at
    // all. Say so, rather than dereferencing features[0] and reporting a
    // TypeError as though the request had failed.
    const stations = (stationsData && stationsData.features) || [];
    if (!stations.length || !stations[0].properties) {
      throw new Error('No observation station near this location');
    }
    const stationId = stations[0].properties.stationIdentifier;
    const obs = await ns.apiFetch(ns.API_BASE + '/stations/' + stationId + '/observations/latest');
    const p = obs.properties;

    return {
      raw: p,
      station: stationId,
      description: p.textDescription || '',
      timestamp: p.timestamp,
      temperature: _temp(_val(p.temperature)),
      dewpoint:    _temp(_val(p.dewpoint)),
      humidity:    _round(_val(p.relativeHumidity), 0),
      wind: {
        speedKmh:  _val(p.windSpeed),
        speedMph:  ns.kmhToMph(_val(p.windSpeed)),
        direction: _val(p.windDirection),
        gustKmh:   _val(p.windGust),
        gustMph:   ns.kmhToMph(_val(p.windGust)),
      },
      barometer: {
        pa:   _val(p.barometricPressure),
        hpa:  ns.paToHpa(_val(p.barometricPressure)),
        inHg: ns.paToInHg(_val(p.barometricPressure)),
      },
      visibility: {
        m:  _val(p.visibility),
        mi: ns.mToMi(_val(p.visibility)),
      },
      heatIndex: _temp(_val(p.heatIndex)),
      windChill: _temp(_val(p.windChill)),
    };
  };

  function _temp(c) {
    return c === null ? null : { c: c, f: ns.cToF(c) };
  }

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
          '<div class="nws-cond-desc">' + _esc(c.description) + '</div>' +
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
        '<div class="nws-cond-meta">Station ' + _esc(c.station) + ' · ' +
          (c.timestamp ? _esc(new Date(c.timestamp).toLocaleString()) : 'time unknown') + '</div>';
    } catch (err) {
      el.innerHTML = '<div class="nws-error">' + _esc(err.message) + '</div>';
    }
  };

  function _cell(label, value) {
    return '<div class="nws-cond-cell"><span class="nws-cond-label">' + label + '</span><span class="nws-cond-value">' + value + '</span></div>';
  }

})(NWS);
