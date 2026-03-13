/**
 * nws-griddata.js — Raw gridpoint numerical forecast data.
 * Depends on: nws-core.js
 *
 * This module provides access to the full gridpoint data including:
 *   temperature, dewpoint, maxTemperature, minTemperature,
 *   relativeHumidity, apparentTemperature, heatIndex, windChill,
 *   skyCover, windDirection, windSpeed, windGust,
 *   probabilityOfPrecipitation, quantitativePrecipitation,
 *   snowfallAmount, visibility, weather, hazards, etc.
 *
 * Each property is a time series array of { validTime, value } objects.
 * validTime is ISO 8601 with a duration suffix (e.g. "2026-03-12T06:00:00+00:00/PT1H").
 */

(function (ns) {
  'use strict';

  ns.griddata = {};

  /**
   * Fetch the raw gridpoint data.
   * @returns {Promise<Object>} properties from /gridpoints/{office}/{x},{y}
   */
  ns.griddata.fetch = async function () {
    ns.ensureReady();
    const data = await ns.apiFetch(ns.location.forecastGridDataUrl);
    return data.properties;
  };

  /**
   * Extract a single layer (e.g. 'temperature') as a flat array.
   * @param {string} layer  property name from the gridpoint data
   * @returns {Promise<Array<{time: string, value: number, duration: string}>>}
   */
  ns.griddata.getLayer = async function (layer) {
    const grid = await ns.griddata.fetch();
    const raw = grid[layer];
    if (!raw || !raw.values) return [];

    return raw.values.map(function (entry) {
      // validTime format: "2026-03-12T06:00:00+00:00/PT1H"
      var parts = entry.validTime.split('/');
      return {
        time: parts[0],
        duration: parts[1] || 'PT1H',
        value: entry.value,
      };
    });
  };

  /**
   * Convenience: get multiple layers at once.
   * @param {Array<string>} layers  e.g. ['temperature', 'probabilityOfPrecipitation']
   * @returns {Promise<Object>}  keyed by layer name
   */
  ns.griddata.getLayers = async function (layers) {
    const grid = await ns.griddata.fetch();
    var result = {};
    layers.forEach(function (layer) {
      var raw = grid[layer];
      if (!raw || !raw.values) { result[layer] = []; return; }
      result[layer] = raw.values.map(function (entry) {
        var parts = entry.validTime.split('/');
        return { time: parts[0], duration: parts[1] || 'PT1H', value: entry.value };
      });
    });
    return result;
  };

})(NWS);
