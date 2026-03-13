/**
 * nws-forecast.js — 7-day (12h period) and hourly forecast.
 * Depends on: nws-core.js
 */

(function (ns) {
  'use strict';

  ns.forecast = {};

  /**
   * Fetch 7-day forecast (12-hour periods).
   * @returns {Promise<Array>}
   */
  ns.forecast.fetch = async function () {
    ns.ensureReady();
    const data = await ns.apiFetch(ns.location.forecastUrl);
    return data.properties.periods.map(function (p) {
      return {
        name: p.name,
        number: p.number,
        temperature: p.temperature,
        temperatureUnit: p.temperatureUnit,
        windSpeed: p.windSpeed,
        windDirection: p.windDirection,
        shortForecast: p.shortForecast,
        detailedForecast: p.detailedForecast,
        isDaytime: p.isDaytime,
        startTime: p.startTime,
        endTime: p.endTime,
      };
    });
  };

  /**
   * Fetch hourly forecast (~156 hours).
   * @returns {Promise<Array>}
   */
  ns.forecast.fetchHourly = async function () {
    ns.ensureReady();
    const data = await ns.apiFetch(ns.location.forecastHourlyUrl);
    return data.properties.periods;
  };

  /**
   * Render the 7-day forecast into a target element.
   * @param {string|HTMLElement} target
   */
  ns.forecast.render = async function (target) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return;
    el.classList.add('nws-forecast');
    el.innerHTML = '<div class="nws-loading">Loading forecast…</div>';

    try {
      const periods = await ns.forecast.fetch();
      let html = '<div class="nws-forecast-strip">';
      periods.forEach(function (p) {
        const cls = p.isDaytime ? 'nws-fp-day' : 'nws-fp-night';
        html +=
          '<div class="nws-fp ' + cls + '">' +
            '<div class="nws-fp-name">' + p.name + '</div>' +
            '<div class="nws-fp-temp">' + p.temperature + '°' + p.temperatureUnit + '</div>' +
            '<div class="nws-fp-short">' + p.shortForecast + '</div>' +
            '<div class="nws-fp-wind">' + p.windSpeed + ' ' + p.windDirection + '</div>' +
          '</div>';
      });
      html += '</div>';
      el.innerHTML = html;
    } catch (err) {
      el.innerHTML = '<div class="nws-error">' + err.message + '</div>';
    }
  };

  /**
   * Render a compact hourly table (next 24 hours).
   * @param {string|HTMLElement} target
   * @param {number} hours  how many hours to show (default 24)
   */
  ns.forecast.renderHourly = async function (target, hours) {
    hours = hours || 24;
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return;
    el.classList.add('nws-hourly');
    el.innerHTML = '<div class="nws-loading">Loading hourly forecast…</div>';

    try {
      const periods = await ns.forecast.fetchHourly();
      const slice = periods.slice(0, hours);
      let html = '<div class="nws-hourly-strip">';
      slice.forEach(function (p) {
        const t = new Date(p.startTime);
        const label = t.toLocaleTimeString([], { hour: 'numeric' });
        html +=
          '<div class="nws-hp">' +
            '<div class="nws-hp-time">' + label + '</div>' +
            '<div class="nws-hp-temp">' + p.temperature + '°</div>' +
            '<div class="nws-hp-short">' + p.shortForecast + '</div>' +
          '</div>';
      });
      html += '</div>';
      el.innerHTML = html;
    } catch (err) {
      el.innerHTML = '<div class="nws-error">' + err.message + '</div>';
    }
  };

})(NWS);
