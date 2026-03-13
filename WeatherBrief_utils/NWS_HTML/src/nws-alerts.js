/**
 * nws-alerts.js — Active weather alerts for the resolved point.
 * Depends on: nws-core.js
 */

(function (ns) {
  'use strict';

  ns.alerts = {};

  /**
   * Fetch active alerts for the current point.
   * @returns {Promise<Array>}
   */
  ns.alerts.fetch = async function () {
    ns.ensureReady();
    const url = ns.API_BASE + '/alerts/active?point=' +
      ns.location.lat.toFixed(4) + ',' + ns.location.lon.toFixed(4);
    const data = await ns.apiFetch(url);
    return (data.features || []).map(function (f) {
      const p = f.properties;
      return {
        id: f.id,
        event: p.event,
        headline: p.headline,
        severity: p.severity,
        urgency: p.urgency,
        certainty: p.certainty,
        description: p.description,
        instruction: p.instruction,
        onset: p.onset,
        expires: p.expires,
        senderName: p.senderName,
        areaDesc: p.areaDesc,
        response: p.response,
      };
    });
  };

  /**
   * Fetch active alerts for an entire state.
   * @param {string} state  two-letter code, e.g. 'NY'
   * @returns {Promise<Array>}
   */
  ns.alerts.fetchByState = async function (state) {
    const url = ns.API_BASE + '/alerts/active?area=' + encodeURIComponent(state);
    const data = await ns.apiFetch(url);
    return (data.features || []).map(function (f) {
      const p = f.properties;
      return {
        id: f.id,
        event: p.event,
        headline: p.headline,
        severity: p.severity,
        urgency: p.urgency,
        certainty: p.certainty,
        description: p.description,
        instruction: p.instruction,
        onset: p.onset,
        expires: p.expires,
        senderName: p.senderName,
        areaDesc: p.areaDesc,
      };
    });
  };

  /**
   * Render active alerts into a target element.
   * @param {string|HTMLElement} target
   */
  ns.alerts.render = async function (target) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return;
    el.classList.add('nws-alerts');
    el.innerHTML = '<div class="nws-loading">Checking alerts…</div>';

    try {
      const alerts = await ns.alerts.fetch();
      if (!alerts.length) {
        el.innerHTML = '<div class="nws-alert-clear">No active alerts for this area.</div>';
        return;
      }
      let html = '';
      alerts.forEach(function (a) {
        const sev = (a.severity || 'unknown').toLowerCase();
        html +=
          '<details class="nws-alert nws-sev-' + sev + '">' +
            '<summary>' +
              '<span class="nws-alert-badge">' + a.severity + '</span>' +
              '<span class="nws-alert-event">' + a.event + '</span>' +
            '</summary>' +
            '<div class="nws-alert-body">' +
              (a.headline ? '<p class="nws-alert-hl">' + a.headline + '</p>' : '') +
              '<p class="nws-alert-desc">' + (a.description || '').replace(/\n/g, '<br>') + '</p>' +
              (a.instruction ? '<p class="nws-alert-instr"><strong>Instructions:</strong> ' + a.instruction.replace(/\n/g, '<br>') + '</p>' : '') +
              '<p class="nws-alert-meta">' +
                'Urgency: ' + a.urgency + ' · Certainty: ' + a.certainty +
                (a.expires ? ' · Expires: ' + new Date(a.expires).toLocaleString() : '') +
              '</p>' +
            '</div>' +
          '</details>';
      });
      el.innerHTML = html;
    } catch (err) {
      el.innerHTML = '<div class="nws-error">' + err.message + '</div>';
    }
  };

})(NWS);
