/**
 * nws-radar.js — NWS Radar station info, direct image URLs, and embeddable URLs.
 * Depends on: nws-core.js
 *
 * Image URLs from radar.weather.gov:
 *   Loop GIF:   https://radar.weather.gov/ridge/standard/{STATION}_loop.gif
 *   Latest GIF: https://radar.weather.gov/ridge/standard/{STATION}_0.gif
 *
 * Includes a catalog of WSR-88D stations with coordinates
 * for distance-based nearby-station lookup.
 */

(function (ns) {
  'use strict';

  ns.radar = {};

  // ── WSR-88D station catalog ────────────────────────────────
  // Each entry: [id, lat, lon, label]
  // Only K-prefixed WSR-88D stations — these have GIF images at
  // radar.weather.gov/ridge/standard/{STATION}_loop.gif
  var STATIONS = [
    // Northeast / Mid-Atlantic
    ['KOKX', 40.8656, -72.8639, 'Upton, NY (NYC/LI)'],
    ['KDIX', 39.9471, -74.4108, 'Fort Dix, NJ (Philadelphia)'],
    ['KENX', 42.5864, -74.0639, 'East Berne, NY (Albany)'],
    ['KBOX', 41.9558, -71.1369, 'Taunton, MA (Boston)'],
    ['KGYX', 43.8914, -70.2564, 'Gray, ME (Portland)'],
    ['KCBW', 46.0392, -67.8067, 'Caribou, ME'],
    ['KCXX', 44.5111, -73.1664, 'Burlington, VT'],
    ['KTYX', 43.7558, -75.6800, 'Montague, NY (Ft. Drum)'],
    ['KBGM', 42.1997, -75.9847, 'Binghamton, NY'],
    ['KBUF', 42.9489, -78.7369, 'Buffalo, NY'],
    ['KDOX', 38.8256, -75.4400, 'Dover AFB, DE'],
    ['KCCX', 40.9228, -78.0039, 'State College, PA'],
    ['KPBZ', 40.5317, -80.0183, 'Pittsburgh, PA'],
    ['KLWX', 38.9753, -77.4778, 'Sterling, VA (DC)'],
    ['KAKQ', 36.9839, -77.0072, 'Wakefield, VA'],
    // Southeast
    ['KRAX', 35.6656, -78.4900, 'Raleigh, NC'],
    ['KLTX', 33.9892, -78.4292, 'Wilmington, NC'],
    ['KMHX', 34.7761, -76.8764, 'Morehead City, NC'],
    ['KGSP', 34.8833, -82.2200, 'Greer, SC (Greenville)'],
    ['KCLX', 32.6556, -81.0422, 'Charleston, SC'],
    ['KCAE', 33.9486, -81.1186, 'Columbia, SC'],
    ['KJAX', 30.4847, -81.7019, 'Jacksonville, FL'],
    ['KMLB', 28.1133, -80.6542, 'Melbourne, FL'],
    ['KAMX', 25.6111, -80.4128, 'Miami, FL'],
    ['KTBW', 27.7056, -82.4017, 'Tampa Bay, FL'],
    ['KTLH', 30.3975, -84.3289, 'Tallahassee, FL'],
    ['KEVX', 30.5644, -85.9214, 'Eglin AFB, FL'],
    ['KMOB', 30.6794, -88.2397, 'Mobile, AL'],
    ['KBMX', 33.1722, -86.7700, 'Birmingham, AL'],
    ['KHTX', 34.9306, -86.0833, 'Huntsville, AL'],
    ['KJGX', 32.6753, -83.3511, 'Macon, GA'],
    ['KFFC', 33.3636, -84.5658, 'Atlanta, GA'],
    // Great Lakes / Ohio Valley
    ['KCLE', 41.4131, -81.8597, 'Cleveland, OH'],
    ['KILN', 39.4203, -83.8217, 'Wilmington, OH (Cincinnati)'],
    ['KDTX', 42.6997, -83.4717, 'Detroit, MI'],
    ['KGRR', 42.8939, -85.5447, 'Grand Rapids, MI'],
    ['KAPX', 44.9072, -84.7197, 'Gaylord, MI'],
    ['KMKX', 42.9678, -88.5506, 'Milwaukee, WI'],
    ['KGRB', 44.4986, -88.1114, 'Green Bay, WI'],
    ['KARX', 43.8228, -91.1911, 'La Crosse, WI'],
    ['KILX', 40.1506, -89.3369, 'Lincoln, IL'],
    ['KLOT', 41.6044, -88.0847, 'Chicago, IL'],
    ['KIND', 39.7075, -86.2803, 'Indianapolis, IN'],
    ['KIWX', 41.3586, -85.7000, 'North Webster, IN'],
    ['KVWX', 38.2603, -87.7247, 'Evansville, IN'],
    // Upper Midwest
    ['KMPX', 44.8489, -93.5653, 'Minneapolis, MN'],
    ['KDLH', 46.8369, -92.2097, 'Duluth, MN'],
    ['KDMX', 41.7311, -93.7228, 'Des Moines, IA'],
    ['KDVN', 41.6117, -90.5808, 'Davenport, IA'],
    ['KFSD', 43.5878, -96.7289, 'Sioux Falls, SD'],
    ['KABR', 45.4558, -98.4131, 'Aberdeen, SD'],
    ['KUDX', 44.1250, -102.8297, 'Rapid City, SD'],
    ['KBIS', 46.7708, -100.7606, 'Bismarck, ND'],
    ['KMVX', 47.5281, -97.3256, 'Grand Forks, ND'],
    // Southern Plains
    ['KTLX', 35.3331, -97.2778, 'Oklahoma City, OK'],
    ['KINX', 36.1750, -95.5644, 'Tulsa, OK'],
    ['KVNX', 36.7408, -98.1275, 'Enid, OK (Vance AFB)'],
    ['KFWS', 32.5731, -97.3031, 'Dallas/Fort Worth, TX'],
    ['KEWX', 29.7039, -98.0286, 'San Antonio, TX'],
    ['KHGX', 29.4719, -95.0792, 'Houston, TX'],
    ['KBRO', 25.9161, -97.4189, 'Brownsville, TX'],
    ['KCRP', 27.7842, -97.5111, 'Corpus Christi, TX'],
    ['KLBB', 33.6536, -101.8142, 'Lubbock, TX'],
    ['KMAF', 31.9433, -102.1892, 'Midland, TX'],
    ['KAMA', 35.2331, -101.7092, 'Amarillo, TX'],
    ['KSJT', 31.3714, -100.4925, 'San Angelo, TX'],
    ['KSHV', 32.4508, -93.8414, 'Shreveport, LA'],
    ['KLIX', 30.3367, -89.8256, 'New Orleans, LA'],
    ['KLCH', 30.1253, -93.2156, 'Lake Charles, LA'],
    ['KLZK', 34.8364, -92.2622, 'Little Rock, AR'],
    // Northern / Central Plains
    ['KOAX', 41.3203, -96.3667, 'Omaha, NE'],
    ['KLNX', 41.9578, -100.5761, 'North Platte, NE'],
    ['KGLD', 39.3669, -101.7003, 'Goodland, KS'],
    ['KICT', 37.6547, -97.4428, 'Wichita, KS'],
    ['KEAX', 38.8103, -94.2644, 'Kansas City, MO'],
    ['KLSX', 38.6986, -90.6828, 'St. Louis, MO'],
    ['KSGF', 37.2353, -93.4006, 'Springfield, MO'],
    // Rockies / Mountain West
    ['KFTG', 39.7867, -104.5458, 'Denver, CO'],
    ['KPUX', 38.4597, -104.1814, 'Pueblo, CO'],
    ['KGJX', 39.0622, -108.2139, 'Grand Junction, CO'],
    ['KCYS', 41.1519, -104.8061, 'Cheyenne, WY'],
    ['KRIW', 43.0661, -108.4772, 'Riverton, WY'],
    ['KSLC', 40.9725, -111.9300, 'Salt Lake City, UT'],
    ['KBOI', 43.5644, -116.2144, 'Boise, ID'],
    ['KSFX', 43.1058, -112.6861, 'Pocatello, ID'],
    ['KMSX', 47.0411, -113.9864, 'Missoula, MT'],
    ['KTFX', 47.4597, -111.3856, 'Great Falls, MT'],
    ['KGGW', 48.2064, -106.6253, 'Glasgow, MT'],
    ['KBLX', 45.8539, -108.6069, 'Billings, MT'],
    // Southwest
    ['KIWA', 33.2892, -111.6700, 'Phoenix, AZ'],
    ['KEMX', 31.8936, -110.6303, 'Tucson, AZ'],
    ['KFSX', 34.5744, -111.1983, 'Flagstaff, AZ'],
    ['KYUX', 32.4953, -114.6567, 'Yuma, AZ'],
    ['KFDX', 34.6350, -103.6297, 'Cannon AFB, NM'],
    ['KABX', 35.1497, -106.8239, 'Albuquerque, NM'],
    ['KHDX', 33.0764, -106.1231, 'Holloman AFB, NM'],
    ['KLRX', 40.7397, -116.8025, 'Elko, NV'],
    ['KRGX', 39.7542, -119.4622, 'Reno, NV'],
    ['KESX', 35.7011, -114.8917, 'Las Vegas, NV'],
    // Pacific Coast
    ['KATX', 48.1944, -122.4958, 'Seattle, WA'],
    ['KOTX', 47.6803, -117.6267, 'Spokane, WA'],
    ['KRTX', 45.7150, -122.9653, 'Portland, OR'],
    ['KPDT', 45.6906, -118.8528, 'Pendleton, OR'],
    ['KMAX', 42.0811, -122.7169, 'Medford, OR'],
    ['KBHX', 40.4986, -124.2919, 'Eureka, CA'],
    ['KDAX', 38.5011, -121.6778, 'Sacramento, CA'],
    ['KMUX', 37.1553, -121.8983, 'San Francisco, CA'],
    ['KVBX', 34.8383, -120.3975, 'Vandenberg, CA'],
    ['KSOX', 33.8178, -117.6358, 'Santa Ana Mts, CA (LA)'],
    ['KNKX', 32.9189, -117.0419, 'San Diego, CA'],
    ['KHNX', 36.3142, -119.6319, 'Hanford, CA (Fresno)'],
  ];

  ns.radar.STATIONS = STATIONS;

  /**
   * Find nearby radar stations sorted by distance from a point.
   * @param {number} lat
   * @param {number} lon
   * @param {number} maxResults  default 5
   * @param {number} maxDistMi   max distance in miles (default 150)
   * @returns {Array<{id, lat, lon, label, distMi}>}
   */
  ns.radar.findNearby = function (lat, lon, maxResults, maxDistMi) {
    maxResults = maxResults || 5;
    maxDistMi = maxDistMi || 150;

    function haversine(lat1, lon1, lat2, lon2) {
      var R = 3958.8; // miles
      var dLat = (lat2 - lat1) * Math.PI / 180;
      var dLon = (lon2 - lon1) * Math.PI / 180;
      var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    var results = [];
    for (var i = 0; i < STATIONS.length; i++) {
      var s = STATIONS[i];
      var d = haversine(lat, lon, s[1], s[2]);
      if (d <= maxDistMi) {
        results.push({ id: s[0], lat: s[1], lon: s[2], label: s[3], distMi: Math.round(d) });
      }
    }
    results.sort(function (a, b) { return a.distMi - b.distMi; });
    return results.slice(0, maxResults);
  };

  /**
   * Build radar URLs for a given station.
   * @param {Object} opts  { zoom: 8, station: null (auto) }
   * @returns {Object}
   */
  ns.radar.getInfo = function (opts) {
    ns.ensureReady();
    opts = opts || {};
    var station = opts.station || ns.location.radarStation || 'KOKX';
    var zoom = opts.zoom || 8;

    var settings = {
      agenda: {
        id: 'local',
        center: [ns.location.lon, ns.location.lat],
        location: null,
        zoom: zoom,
        filter: 'WSR-88D',
        layer: 'sr_bref',
        station: station,
      },
      animating: false,
      base: 'standard',
      artcc: false,
      county: false,
      cwa: false,
      rfc: false,
      state: false,
      menu: true,
      shortFusedOnly: true,
      opacity: { alerts: 0.8, local: 0.6, localStations: 0.8, national: 0.6 },
    };

    return {
      station: station,
      latestImageUrl: ns.RADAR_BASE + '/ridge/standard/' + station + '_0.gif',
      loopImageUrl:   ns.RADAR_BASE + '/ridge/standard/' + station + '_loop.gif',
      stationPageUrl: ns.RADAR_BASE + '/station/' + station + '/standard',
      embedUrl: ns.RADAR_BASE + '/?settings=v1_' + btoa(JSON.stringify(settings)),
      mosaicUrl: ns.RADAR_BASE,
    };
  };

  /**
   * Render radar as a direct GIF image.
   * @param {string|HTMLElement} target
   * @param {Object} opts  { loop: true, station: null }
   */
  ns.radar.renderImage = function (target, opts) {
    ns.ensureReady();
    opts = opts || {};
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return;
    el.classList.add('nws-radar');

    var info = ns.radar.getInfo(opts);
    var src = opts.loop !== false ? info.loopImageUrl : info.latestImageUrl;

    el.innerHTML =
      '<div class="nws-radar-header">' +
        '<span>WSR-88D ' + info.station + (opts.loop !== false ? ' · Loop' : ' · Latest') + '</span>' +
        '<a href="' + info.stationPageUrl + '" target="_blank" rel="noopener">Full page →</a>' +
      '</div>' +
      '<img class="nws-radar-img" src="' + src + '"' +
        ' alt="Radar ' + info.station + '"' +
        ' loading="lazy"' +
        ' onerror="this.alt=\'Radar image unavailable\'">';
  };

  /**
   * Render multiple nearby radar stations with tabs.
   * The NWS-assigned radar for the location is always first,
   * followed by other nearby stations sorted by distance.
   *
   * @param {string|HTMLElement} target
   * @param {Object} opts  { loop: true, maxStations: 5, maxDistMi: 150 }
   */
  ns.radar.renderMulti = function (target, opts) {
    ns.ensureReady();
    opts = opts || {};
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return;
    el.classList.add('nws-radar');

    var maxStations = opts.maxStations || 5;
    var assigned = ns.location.radarStation || 'KOKX';

    // Find nearby stations
    var nearby = ns.radar.findNearby(ns.location.lat, ns.location.lon, maxStations + 1, opts.maxDistMi || 150);

    // Build the tab list: assigned station first, then others
    var tabs = [];
    var assignedDist = null;

    // Find assigned in nearby list
    for (var i = 0; i < nearby.length; i++) {
      if (nearby[i].id === assigned) {
        assignedDist = nearby[i].distMi;
        break;
      }
    }

    // Add assigned station as first tab
    tabs.push({
      id: assigned,
      label: assigned,
      sublabel: assignedDist !== null ? assignedDist + ' mi · assigned' : 'assigned',
    });

    // Add other nearby stations (skip if already assigned)
    for (var j = 0; j < nearby.length && tabs.length < maxStations; j++) {
      if (nearby[j].id !== assigned) {
        tabs.push({
          id: nearby[j].id,
          label: nearby[j].id,
          sublabel: nearby[j].distMi + ' mi · ' + nearby[j].label,
        });
      }
    }

    // Build tab HTML
    var btns = '';
    tabs.forEach(function (t, idx) {
      btns += '<button class="nws-radar-tab' + (idx === 0 ? ' active' : '') + '"' +
        ' data-station="' + t.id + '"' +
        ' title="' + t.sublabel + '">' +
        t.label + '<span class="nws-radar-tab-sub">' + t.sublabel + '</span>' +
        '</button>';
    });

    el.innerHTML =
      '<div class="nws-radar-tabs">' + btns + '</div>' +
      '<div class="nws-radar-container"></div>';

    var container = el.querySelector('.nws-radar-container');

    function loadStation(stationId) {
      var info = ns.radar.getInfo({ station: stationId });
      var src = opts.loop !== false ? info.loopImageUrl : info.latestImageUrl;

      container.innerHTML =
        '<div class="nws-radar-header">' +
          '<span>WSR-88D ' + info.station + (opts.loop !== false ? ' · Loop' : ' · Latest') + '</span>' +
          '<a href="' + info.stationPageUrl + '" target="_blank" rel="noopener">Full page →</a>' +
        '</div>' +
        '<img class="nws-radar-img" src="' + src + '"' +
          ' alt="Radar ' + info.station + '"' +
          ' loading="lazy"' +
          ' onerror="this.alt=\'Radar image unavailable\'">';
    }

    // Wire tabs
    el.querySelectorAll('.nws-radar-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        el.querySelectorAll('.nws-radar-tab').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        loadStation(btn.getAttribute('data-station'));
      });
    });

    // Load assigned station
    loadStation(assigned);
  };

  /**
   * Render an interactive radar iframe.
   * @param {string|HTMLElement} target
   * @param {Object} opts  { height, zoom, station }
   */
  ns.radar.renderEmbed = function (target, opts) {
    ns.ensureReady();
    opts = opts || {};
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return;
    el.classList.add('nws-radar');

    var info = ns.radar.getInfo(opts);
    var h = opts.height || '500px';

    el.innerHTML =
      '<div class="nws-radar-header">' +
        '<span>WSR-88D ' + info.station + ' · Interactive</span>' +
        '<a href="' + info.stationPageUrl + '" target="_blank" rel="noopener">Full page →</a>' +
      '</div>' +
      '<iframe class="nws-radar-iframe" src="' + info.embedUrl + '"' +
        ' style="width:100%;height:' + h + ';border:0;"' +
        ' loading="lazy" title="NWS Radar ' + info.station + '" allowfullscreen></iframe>';
  };

  // backward compat alias
  ns.radar.render = ns.radar.renderEmbed;

})(NWS);