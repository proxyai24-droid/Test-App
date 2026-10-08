/*
 * core.js - pure helper functions (no phone or screen code in here).
 * Kept separate so the ZIP format can be tested on a PC.
 *
 * THE ZIP FORMAT IS A FIXED CONTRACT with Site Register (desktop).
 * Do not rename fields or change the structure in buildManifest().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PRIORITIES = ['High', 'Medium', 'Low'];
  var MAX_PHOTOS = 5;

  function uuid() {
    var c = (typeof crypto !== 'undefined') ? crypto : null;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    var b = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function pad(n) { return ('0' + n).slice(-2); }

  // 20260310_1445 (phone local time)
  function stamp(d) {
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes());
  }

  function safeName(s) {
    var t = String(s || '').trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return t || 'Phone';
  }

  // SiteActions_<DeviceName>_<YYYYMMDD_HHMM>.zip
  function zipName(device, d) {
    return 'SiteActions_' + safeName(device) + '_' + stamp(d) + '.zip';
  }

  // Reasons an entry cannot be exported yet. Empty array = OK.
  function problems(e) {
    var p = [];
    if (!e.photos || e.photos.length === 0) p.push('no photo');
    if (!e.caption || !String(e.caption).trim()) p.push('no caption');
    if (!e.project || !String(e.project).trim()) p.push('no project');
    return p;
  }

  // Builds manifest.json content and the list of photos to copy into the ZIP.
  // photoMap: [{ from: <path inside phone storage>, to: 'photos/<entryId>_<n>.jpg' }]
  function buildManifest(entries, device, now, exportId) {
    var photoMap = [];
    var out = entries.map(function (e) {
      var photos = (e.photos || []).map(function (p, i) {
        var to = 'photos/' + e.id + '_' + (i + 1) + '.jpg';
        photoMap.push({ from: p, to: to });
        return to;
      });
      return {
        id: e.id,
        createdAt: e.createdAt,
        project: String(e.project || '').trim(),
        area: String(e.area || '').trim(),
        priority: PRIORITIES.indexOf(e.priority) >= 0 ? e.priority : 'Medium',
        caption: String(e.caption || '').trim(),
        assignee: String(e.assignee || '').trim(),
        dueDate: e.dueDate || '',
        photos: photos
      };
    });
    return {
      manifest: {
        format: 'site-actions',
        version: 1,
        exportId: exportId || uuid(),
        exportedAt: now.toISOString(),
        device: String(device || '').trim() || 'Phone',
        entries: out
      },
      photoMap: photoMap
    };
  }

  // One name per line -> clean unique list
  function parseList(text) {
    var seen = {}, out = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var t = line.replace(/^\uFEFF/, '').trim();
      var k = t.toLowerCase();
      if (t && !seen[k]) { seen[k] = 1; out.push(t); }
    });
    return out;
  }

  function addToList(list, name) {
    var t = String(name || '').trim();
    if (!t) return list;
    var exists = list.some(function (x) { return x.toLowerCase() === t.toLowerCase(); });
    return exists ? list : list.concat([t]);
  }

  return {
    PRIORITIES: PRIORITIES, MAX_PHOTOS: MAX_PHOTOS,
    uuid: uuid, stamp: stamp, safeName: safeName, zipName: zipName,
    problems: problems, buildManifest: buildManifest, parseList: parseList, addToList: addToList
  };
});
