/*
 * app.js - Site Actions Capture
 *
 * What this file does, in order:
 *   1. Storage    - entries and settings live in Capacitor Preferences,
 *                   photos live as files in the app's private folder.
 *   2. Screens    - Home list, New/Edit form, Settings, plus pop-up sheets.
 *   3. Photos     - camera/gallery -> resized JPEG -> private storage.
 *   4. Export     - builds the ZIP (format lives in core.js) and opens Share.
 *
 * Nothing here needs internet. No login, no server, no analytics.
 */
(function () {
  'use strict';

  var Core = window.Core;
  var Cap = window.Capacitor;
  var Plugins = (Cap && Cap.Plugins) || {};
  var FS = Plugins.Filesystem;
  var Prefs = Plugins.Preferences;
  var Cam = Plugins.Camera;
  var Share = Plugins.Share;
  var AppPlugin = Plugins.App;

  var VERSION = '1.0.0';
  var KEY_ENTRIES = 'sa_entries';
  var KEY_ENTRIES_BAK = 'sa_entries_bak';
  var KEY_SETTINGS = 'sa_settings';

  var state = {
    entries: [],          // newest first
    settings: defaultSettings(),
    filter: 'all',        // all | pending | exported
    view: 'home',         // home | form | settings
    form: null,           // { entry, isNew, added[], removed[], snap }
    baseUri: ''           // file:// folder where photos live (for thumbnails)
  };
  var overlays = [];      // open pop-ups, top one is last

  function defaultSettings() {
    return {
      projects: [], assignees: [], areas: [],
      device: '', maxPx: 1600, quality: 75,
      lastProject: '', lastArea: ''
    };
  }

  /* ------------------------------------------------------------------ */
  /* small helpers                                                       */
  /* ------------------------------------------------------------------ */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function errText(e) { return String((e && (e.message || e.errorMessage)) || e || 'Unknown error'); }
  function isCancel(e) { return /cancel/i.test(errText(e)); }

  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3200);
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function fmtDateTime(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  /* ------------------------------------------------------------------ */
  /* storage                                                             */
  /* ------------------------------------------------------------------ */
  async function readJSON(key, fallback, bakKey) {
    try {
      var r = await Prefs.get({ key: key });
      if (r && r.value) return JSON.parse(r.value);
    } catch (e) { /* try backup below */ }
    if (bakKey) {
      try {
        var b = await Prefs.get({ key: bakKey });
        if (b && b.value) return JSON.parse(b.value);
      } catch (e2) { /* ignore */ }
    }
    return fallback;
  }

  // Entries are saved right away, and the previous version is kept as a backup copy.
  async function persistEntries() {
    try {
      var prev = await Prefs.get({ key: KEY_ENTRIES });
      if (prev && prev.value) await Prefs.set({ key: KEY_ENTRIES_BAK, value: prev.value });
    } catch (e) { /* backup is best effort */ }
    await Prefs.set({ key: KEY_ENTRIES, value: JSON.stringify(state.entries) });
  }
  async function persistSettings() {
    await Prefs.set({ key: KEY_SETTINGS, value: JSON.stringify(state.settings) });
  }

  async function writePhoto(path, base64) {
    await FS.writeFile({ path: path, data: base64, directory: 'DATA', recursive: true });
  }
  async function deletePhoto(path) {
    try { await FS.deleteFile({ path: path, directory: 'DATA' }); } catch (e) { /* already gone */ }
  }
  function photoSrc(path) {
    if (!state.baseUri || !Cap || !Cap.convertFileSrc) return '';
    return Cap.convertFileSrc(state.baseUri + '/' + path);
  }

  /* ------------------------------------------------------------------ */
  /* pop-ups (sheets), busy box, photo viewer                            */
  /* ------------------------------------------------------------------ */
  // opts: { title, html, buttons:[{label, cls, value}], row:boolean, sticky:boolean, onMount(root, close) }
  // Resolves with the clicked button's value, or null if dismissed.
  function sheet(opts) {
    return new Promise(function (resolve) {
      var scrim = document.createElement('div');
      scrim.className = 'scrim';
      var btns = (opts.buttons || []).map(function (b, i) {
        return '<button class="btn ' + (b.cls || '') + '" data-btn="' + i + '">' + esc(b.label) + '</button>';
      }).join('');
      scrim.innerHTML =
        '<div class="sheet" role="dialog" aria-modal="true">' +
        '<h3>' + esc(opts.title || '') + '</h3>' +
        '<div class="sheet-body">' + (opts.html || '') + '</div>' +
        (btns ? '<div class="sheet-btns' + (opts.row ? ' two' : '') + '">' + btns + '</div>' : '') +
        '</div>';
      var entry = { close: function () { close(null); } };
      function close(value) {
        var i = overlays.indexOf(entry);
        if (i >= 0) overlays.splice(i, 1);
        scrim.remove();
        resolve(value);
      }
      scrim.addEventListener('click', function (ev) {
        if (ev.target === scrim && !opts.sticky) { close(null); return; }
        var b = ev.target.closest('[data-btn]');
        if (b && !b.disabled) close(opts.buttons[+b.dataset.btn].value);
      });
      overlays.push(entry);
      $('#overlay-root').appendChild(scrim);
      if (opts.onMount) opts.onMount(scrim, close);
    });
  }

  async function confirmBox(title, text, yesLabel, danger) {
    var v = await sheet({
      title: title, html: '<p>' + esc(text) + '</p>', row: true,
      buttons: [{ label: 'Cancel', value: false }, { label: yesLabel || 'Yes', cls: danger ? 'danger' : 'primary', value: true }]
    });
    return v === true;
  }

  async function promptBox(title, label, initial) {
    var inputId = 'prompt-input';
    var result = null;
    var v = await sheet({
      title: title, row: true,
      html: '<div class="field"><label for="' + inputId + '">' + esc(label) + '</label>' +
            '<input type="text" id="' + inputId + '" value="' + esc(initial || '') + '" autocomplete="off"></div>',
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Save', cls: 'primary', value: 'ok' }],
      onMount: function (root, close) {
        var input = $('#' + inputId, root);
        setTimeout(function () { input.focus(); }, 60);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { result = input.value; close('ok'); } });
        root.addEventListener('click', function (e) {
          var b = e.target.closest('[data-btn]');
          if (b) result = input.value;
        }, true);
      }
    });
    if (v !== 'ok') return null;
    var t = String(result || '').trim();
    return t || null;
  }

  // Non-closable "please wait" box. Returns { set(msg), done() }.
  function busy(msg) {
    var scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.innerHTML = '<div class="sheet"><h3>Please wait</h3><div class="sheet-body"><p id="busy-msg"></p></div>' +
      '<div class="sheet-btns"></div></div>';
    var entry = { locked: true, close: function () {} };
    overlays.push(entry);
    $('#overlay-root').appendChild(scrim);
    var api = {
      set: function (m) { $('#busy-msg', scrim).textContent = m; },
      done: function () {
        var i = overlays.indexOf(entry);
        if (i >= 0) overlays.splice(i, 1);
        scrim.remove();
      }
    };
    api.set(msg);
    return api;
  }

  function openViewer(src) {
    var v = document.createElement('div');
    v.className = 'viewer';
    v.innerHTML = '<img alt="Site photo" src="' + esc(src) + '"><button class="btn primary">Close photo</button>';
    var entry = { close: close };
    function close() {
      var i = overlays.indexOf(entry);
      if (i >= 0) overlays.splice(i, 1);
      v.remove();
    }
    $('button', v).addEventListener('click', close);
    overlays.push(entry);
    $('#overlay-root').appendChild(v);
  }

  /* ------------------------------------------------------------------ */
  /* rendering                                                           */
  /* ------------------------------------------------------------------ */
  function render() {
    var app = $('#app');
    var prevScroll = $('.scroll', app);
    var keep = (prevScroll && state._lastView === state.view) ? prevScroll.scrollTop : 0;
    if (state.view === 'form') app.innerHTML = formHtml();
    else if (state.view === 'settings') app.innerHTML = settingsHtml();
    else app.innerHTML = homeHtml();
    var sc = $('.scroll', app);
    if (sc && keep) sc.scrollTop = keep;
    state._lastView = state.view;
  }

  function pendingEntries() { return state.entries.filter(function (e) { return e.status !== 'exported'; }); }

  /* ---------- Home ---------- */
  function homeHtml() {
    var pend = pendingEntries().length;
    var exp = state.entries.length - pend;
    var list = state.entries.filter(function (e) {
      if (state.filter === 'pending') return e.status !== 'exported';
      if (state.filter === 'exported') return e.status === 'exported';
      return true;
    });

    var notice = '';
    if (state.settings.projects.length === 0) {
      notice = '<div class="notice"><b>First, add your project names.</b><br>Use the same names as in Site Register so imports match.' +
        '<br><button class="btn dark small" data-act="settings">Open settings</button></div>';
    }

    var rows;
    if (!list.length) {
      rows = state.entries.length === 0
        ? '<div class="empty-state"><strong>No site actions yet</strong>Tap New action to take a photo and write what needs doing.</div>'
        : '<div class="empty-state"><strong>Nothing here</strong>No ' + esc(state.filter) + ' actions.</div>';
    } else {
      rows = list.map(entryRow).join('');
    }

    return '<section class="view">' +
      '<header class="bar"><h1>Site Actions<span class="sub">' + pend + ' pending, ' + exp + ' exported</span></h1>' +
      '<button class="icon-btn" data-act="settings">Settings</button></header>' +
      '<div class="tabs">' +
      tabBtn('all', 'All') + tabBtn('pending', 'Pending') + tabBtn('exported', 'Exported') + '</div>' +
      '<div class="scroll">' + notice + rows + '</div>' +
      '<div class="dock"><button class="btn primary" data-act="new">New action</button>' +
      '<button class="btn dark" data-act="export"' + (pend ? '' : ' disabled') + '>Export (' + pend + ')</button></div>' +
      '</section>';
  }
  function tabBtn(key, label) {
    return '<button class="tab" data-act="filter" data-f="' + key + '" aria-pressed="' + (state.filter === key) + '">' + label + '</button>';
  }

  function entryRow(e) {
    var first = e.photos && e.photos[0];
    var img = first ? '<img alt="" loading="lazy" src="' + esc(photoSrc(first)) + '">' : '';
    var count = (e.photos && e.photos.length > 1) ? '<span class="count">' + e.photos.length + '</span>' : '';
    var exported = e.status === 'exported';
    var incomplete = !exported && Core.problems(e).length > 0;
    var meta = (e.project || 'No project') + (e.area ? ' - ' + e.area : '');
    var cap = e.caption && e.caption.trim()
      ? '<div class="cap">' + esc(e.caption) + '</div>'
      : '<div class="cap empty">No caption yet</div>';
    return '<button class="entry p-' + esc(e.priority) + '" data-act="open" data-id="' + esc(e.id) + '">' +
      '<div class="thumb">' + img + count + '</div>' +
      '<div class="body">' + cap +
      '<div class="meta">' + esc(meta) + '</div>' +
      '<div class="tags">' +
      '<span class="tag ' + esc(e.priority) + '">' + esc(e.priority) + '</span>' +
      '<span class="tag ' + (exported ? 'exported' : 'pending') + '">' + (exported ? 'Exported' : 'Pending') + '</span>' +
      (incomplete ? '<span class="tag warn">Incomplete</span>' : '') +
      (e.dueDate ? '<span class="tag">Due ' + esc(fmtDate(e.dueDate)) + '</span>' : '') +
      '</div></div></button>';
  }

  /* ---------- Form ---------- */
  function optionList(list, current, placeholder) {
    var opts = '<option value="">' + esc(placeholder) + '</option>';
    var has = false;
    list.forEach(function (n) {
      if (n === current) has = true;
      opts += '<option value="' + esc(n) + '"' + (n === current ? ' selected' : '') + '>' + esc(n) + '</option>';
    });
    // keep a value that was saved earlier even if it was later removed from the list
    if (current && !has) opts += '<option value="' + esc(current) + '" selected>' + esc(current) + '</option>';
    opts += '<option value="__new__">+ Add new...</option>';
    return opts;
  }

  function formHtml() {
    var f = state.form, e = f.entry, s = state.settings;
    var areas = s.areas.map(function (a) { return '<option value="' + esc(a) + '">'; }).join('');
    var pri = Core.PRIORITIES.map(function (p) {
      return '<button type="button" class="' + p + '" data-act="pri" data-p="' + p + '" aria-pressed="' + (e.priority === p) + '">' + p + '</button>';
    }).join('');
    return '<section class="view">' +
      '<header class="bar"><button class="icon-btn" data-act="form-back">Back</button>' +
      '<h1>' + (f.isNew ? 'New action' : 'Edit action') + '</h1>' +
      (f.isNew ? '' : '<button class="icon-btn" data-act="form-delete">Delete</button>') + '</header>' +
      '<div class="scroll">' +
      '<div class="field"><label for="f-project">Project</label>' +
      '<select id="f-project" data-f="project">' + optionList(s.projects, e.project, 'Choose project...') + '</select></div>' +
      '<div class="field"><label for="f-area">Area or location</label>' +
      '<input type="text" id="f-area" data-f="area" list="area-list" value="' + esc(e.area) + '" placeholder="e.g. Level 3, Kitchen" autocomplete="off">' +
      '<datalist id="area-list">' + areas + '</datalist></div>' +
      '<div class="field" id="photo-field">' + photoFieldHtml() + '</div>' +
      '<div class="field"><label for="f-caption">Action to be done</label>' +
      '<textarea id="f-caption" data-f="caption" placeholder="What needs to be done here?">' + esc(e.caption) + '</textarea>' +
      '<div class="hint">Tip: tap the microphone on your keyboard to speak instead of typing.</div></div>' +
      '<div class="field"><span class="label">Priority</span><div class="seg" id="pri-seg">' + pri + '</div></div>' +
      '<div class="field"><label for="f-assignee">Assigned to</label>' +
      '<select id="f-assignee" data-f="assignee">' + optionList(s.assignees, e.assignee, 'Nobody yet') + '</select></div>' +
      '<div class="field"><label for="f-due">Due date (optional)</label>' +
      '<input type="date" id="f-due" data-f="dueDate" value="' + esc(e.dueDate) + '"></div>' +
      '</div>' +
      '<div class="dock"><button class="btn" data-act="form-back">Cancel</button>' +
      '<button class="btn primary" data-act="form-save">Save</button></div>' +
      '</section>';
  }

  function photoFieldHtml() {
    var e = state.form.entry, n = e.photos.length, full = n >= Core.MAX_PHOTOS;
    var thumbs = e.photos.map(function (p, i) {
      return '<div class="ph"><button class="pv" data-act="view-photo" data-i="' + i + '" aria-label="View photo ' + (i + 1) + '">' +
        '<img alt="Photo ' + (i + 1) + '" src="' + esc(photoSrc(p)) + '"></button>' +
        '<button class="rm" data-act="rm-photo" data-i="' + i + '" aria-label="Remove photo ' + (i + 1) + '">x</button></div>';
    }).join('');
    return '<span class="label">Photos (' + n + ' of ' + Core.MAX_PHOTOS + ')</span>' +
      '<div class="photo-actions">' +
      '<button class="btn dark" data-act="take"' + (full ? ' disabled' : '') + '>Take photo</button>' +
      '<button class="btn" data-act="gallery"' + (full ? ' disabled' : '') + '>From gallery</button></div>' +
      (n ? '<div class="photos">' + thumbs + '</div>' : '<div class="hint">Add at least one photo before exporting.</div>');
  }

  /* ---------- Settings ---------- */
  function listSection(kind, title, hint) {
    var list = state.settings[kind];
    var rows = list.length ? list.map(function (n, i) {
      return '<div class="row"><span class="name">' + esc(n) + '</span>' +
        '<button class="btn small" data-act="list-rename" data-kind="' + kind + '" data-i="' + i + '">Rename</button>' +
        '<button class="btn small danger" data-act="list-del" data-kind="' + kind + '" data-i="' + i + '">Delete</button></div>';
    }).join('') : '<div class="hint">Nothing added yet.</div>';
    return '<div class="section"><h2>' + title + '</h2><div class="hint" style="margin-bottom:8px">' + hint + '</div>' + rows +
      '<div class="add-row"><input type="text" id="add-' + kind + '" placeholder="Type a name" autocomplete="off">' +
      '<button class="btn dark" data-act="list-add" data-kind="' + kind + '">Add</button></div>' +
      '<div class="btn-row"><button class="btn small" data-act="list-file" data-kind="' + kind + '">Import from text file</button>' +
      '<button class="btn small" data-act="list-paste" data-kind="' + kind + '">Paste a list</button></div>' +
      '<input type="file" class="hidden" id="file-' + kind + '" data-kind="' + kind + '" accept=".txt,.csv,text/plain,text/csv"></div>';
  }

  function settingsHtml() {
    var s = state.settings;
    function opt(v, cur, label) { return '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + label + '</option>'; }
    var exported = state.entries.filter(function (e) { return e.status === 'exported'; }).length;
    return '<section class="view">' +
      '<header class="bar"><button class="icon-btn" data-act="settings-back">Back</button><h1>Settings</h1></header>' +
      '<div class="scroll">' +
      '<div class="section"><h2>This phone</h2>' +
      '<div class="field"><label for="s-device">Device name</label>' +
      '<input type="text" id="s-device" data-s="device" value="' + esc(s.device) + '" placeholder="e.g. Ahmed - Pixel" autocomplete="off">' +
      '<div class="hint">Shown in Site Register after import and used in the ZIP file name.</div></div></div>' +
      listSection('projects', 'Projects', 'Use exactly the same names as in Site Register. Renaming here does not change actions already saved.') +
      listSection('assignees', 'People who can be assigned', 'Use the same names as the users in Site Register. One name per line when importing.') +
      '<div class="section"><h2>Photo size</h2>' +
      '<div class="field"><label for="s-px">Longest side</label><select id="s-px" data-s="maxPx">' +
      opt('1280', String(s.maxPx), '1280 px (smallest files)') + opt('1600', String(s.maxPx), '1600 px (recommended)') + opt('2048', String(s.maxPx), '2048 px (more detail)') + '</select></div>' +
      '<div class="field"><label for="s-q">JPEG quality</label><select id="s-q" data-s="quality">' +
      opt('60', String(s.quality), '60 (smaller)') + opt('75', String(s.quality), '75 (recommended)') + opt('85', String(s.quality), '85 (sharper)') + '</select></div>' +
      '<div class="hint">Applies to new photos only. Location data is never saved in photos.</div></div>' +
      '<div class="section"><h2>Storage</h2>' +
      '<div class="hint" style="margin-bottom:8px">' + state.entries.length + ' actions saved, ' + exported + ' already exported. Exported actions are only removed when you tap below.</div>' +
      '<button class="btn danger" data-act="clear-exported"' + (exported ? '' : ' disabled') + '>Delete exported actions</button></div>' +
      '<div class="hint" style="text-align:center;padding:4px 0 16px">Site Actions Capture v' + VERSION + '</div>' +
      '</div></section>';
  }

  /* ------------------------------------------------------------------ */
  /* photos                                                              */
  /* ------------------------------------------------------------------ */
  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Could not read the photo')); };
      img.src = src;
    });
  }

  // Resize + re-encode as JPEG. Re-encoding through a canvas also drops EXIF, including GPS location.
  async function compressImage(webPath) {
    var img = await loadImage(webPath);
    var maxPx = Number(state.settings.maxPx) || 1600;
    var q = (Number(state.settings.quality) || 75) / 100;
    var w = img.naturalWidth, h = img.naturalHeight;
    var scale = Math.min(1, maxPx / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(img, 0, 0, w, h);
    var dataUrl = cv.toDataURL('image/jpeg', q);
    cv.width = 1; cv.height = 1;
    return dataUrl.split(',')[1];
  }
  var compressFn = compressImage;

  async function pickWebPaths(source, room) {
    if (source === 'camera') {
      var r;
      if (typeof Cam.takePhoto === 'function') r = await Cam.takePhoto({ quality: 90, correctOrientation: true, saveToGallery: false });
      else r = await Cam.getPhoto({ quality: 90, resultType: 'uri', source: 'CAMERA', saveToGallery: false, correctOrientation: true });
      return r && r.webPath ? [r.webPath] : [];
    }
    var g;
    if (typeof Cam.chooseFromGallery === 'function') {
      g = await Cam.chooseFromGallery({ mediaType: 0, allowMultipleSelection: true, limit: room });
      return (g.results || []).map(function (x) { return x.webPath; }).filter(Boolean).slice(0, room);
    }
    g = await Cam.pickImages({ quality: 90, limit: room });
    return (g.photos || []).map(function (x) { return x.webPath; }).filter(Boolean).slice(0, room);
  }

  async function addPhotos(source) {
    var f = state.form;
    if (!f) return;
    var room = Core.MAX_PHOTOS - f.entry.photos.length;
    if (room <= 0) { toast('Maximum ' + Core.MAX_PHOTOS + ' photos per action'); return; }
    var paths;
    try {
      paths = await pickWebPaths(source, room);
    } catch (err) {
      if (!isCancel(err)) toast(/permission|denied/i.test(errText(err))
        ? 'Allow Camera and Photos for this app in phone Settings, then try again.'
        : 'Could not open the camera: ' + errText(err));
      return;
    }
    if (!paths.length || state.form !== f) return;
    var b = busy('Saving photo...');
    try {
      for (var i = 0; i < paths.length; i++) {
        b.set('Saving photo ' + (i + 1) + ' of ' + paths.length + '...');
        var b64 = await compressFn(paths[i]);
        var name = 'photos/' + f.entry.id + '_' + Core.uuid().slice(0, 8) + '.jpg';
        await writePhoto(name, b64);
        f.entry.photos.push(name);
        f.added.push(name);
      }
    } catch (err2) {
      toast('Could not save the photo: ' + errText(err2));
    }
    b.done();
    if (state.form === f) $('#photo-field').innerHTML = photoFieldHtml();
  }

  /* ------------------------------------------------------------------ */
  /* form actions                                                        */
  /* ------------------------------------------------------------------ */
  function snapshot(e) {
    return JSON.stringify([e.project, e.area, e.priority, e.caption, e.assignee, e.dueDate, e.photos]);
  }

  function openForm(existing) {
    var s = state.settings;
    var e;
    if (existing) {
      e = JSON.parse(JSON.stringify(existing));
    } else {
      e = {
        id: Core.uuid(), createdAt: new Date().toISOString(),
        project: s.projects.indexOf(s.lastProject) >= 0 ? s.lastProject : '',
        area: s.lastArea || '', priority: 'Medium', caption: '', assignee: '', dueDate: '',
        photos: [], status: 'pending'
      };
    }
    state.form = { entry: e, isNew: !existing, added: [], removed: [], snap: snapshot(e) };
    state.view = 'form';
    render();
  }

  function formDirty() {
    var f = state.form;
    return !!f && snapshot(f.entry) !== f.snap;
  }

  async function leaveForm(force) {
    var f = state.form;
    if (!f) { state.view = 'home'; render(); return; }
    if (!force && formDirty()) {
      var ok = await confirmBox('Discard changes?', 'Photos and text you added on this screen will be lost.', 'Discard', true);
      if (!ok) return;
    }
    // photos taken during this edit were never saved to an entry
    for (var i = 0; i < f.added.length; i++) await deletePhoto(f.added[i]);
    state.form = null;
    state.view = 'home';
    render();
  }

  async function saveForm() {
    var f = state.form;
    if (!f) return;
    var e = f.entry;
    e.project = String(e.project || '').trim();
    e.area = String(e.area || '').trim();
    e.caption = String(e.caption || '').trim();
    e.assignee = String(e.assignee || '').trim();
    e.status = 'pending';
    e.updatedAt = new Date().toISOString();

    var idx = state.entries.findIndex(function (x) { return x.id === e.id; });
    if (idx >= 0) state.entries[idx] = e; else state.entries.unshift(e);

    var s = state.settings;
    if (e.project) s.lastProject = e.project;
    s.lastArea = e.area;
    if (e.area) {
      s.areas = [e.area].concat(s.areas.filter(function (a) { return a.toLowerCase() !== e.area.toLowerCase(); })).slice(0, 30);
    }
    try {
      await persistEntries();
      await persistSettings();
    } catch (err) {
      toast('Could not save: ' + errText(err));
      return;
    }
    for (var i = 0; i < f.removed.length; i++) await deletePhoto(f.removed[i]);
    var missing = Core.problems(e);
    state.form = null;
    state.view = 'home';
    render();
    toast(missing.length ? 'Saved. Still needed before export: ' + missing.join(', ') : 'Saved');
  }

  async function deleteEntry(id) {
    var e = state.entries.find(function (x) { return x.id === id; });
    if (!e) return;
    (e.photos || []).forEach(function (p) { deletePhoto(p); });
    state.entries = state.entries.filter(function (x) { return x.id !== id; });
    await persistEntries();
  }

  function removePhoto(i) {
    var f = state.form;
    var p = f.entry.photos[i];
    if (!p) return;
    f.entry.photos.splice(i, 1);
    var ai = f.added.indexOf(p);
    if (ai >= 0) { f.added.splice(ai, 1); deletePhoto(p); }   // never saved: delete now
    else f.removed.push(p);                                   // saved earlier: delete when Save is tapped
    $('#photo-field').innerHTML = photoFieldHtml();
  }

  /* ------------------------------------------------------------------ */
  /* detail sheet for exported entries (read only)                       */
  /* ------------------------------------------------------------------ */
  async function showDetail(e) {
    var photos = (e.photos || []).map(function (p, i) {
      return '<button data-photo="' + i + '" aria-label="View photo ' + (i + 1) + '"><img alt="" src="' + esc(photoSrc(p)) + '"></button>';
    }).join('');
    var html = '<div class="detail-photos">' + photos + '</div><dl class="kv">' +
      '<dt>Action</dt><dd>' + esc(e.caption || '-') + '</dd>' +
      '<dt>Project</dt><dd>' + esc(e.project || '-') + '</dd>' +
      '<dt>Area</dt><dd>' + esc(e.area || '-') + '</dd>' +
      '<dt>Priority</dt><dd>' + esc(e.priority) + '</dd>' +
      '<dt>Assigned to</dt><dd>' + esc(e.assignee || '-') + '</dd>' +
      '<dt>Due date</dt><dd>' + esc(e.dueDate ? fmtDate(e.dueDate) : '-') + '</dd>' +
      '<dt>Created</dt><dd>' + esc(fmtDateTime(e.createdAt)) + '</dd>' +
      '<dt>Exported</dt><dd>' + esc(e.exportedAt ? fmtDateTime(e.exportedAt) : '-') + '</dd></dl>' +
      '<p class="hint">Exported actions cannot be edited. Make it pending again if you need to change or re-send it.</p>';
    var v = await sheet({
      title: 'Exported action', html: html,
      buttons: [{ label: 'Make pending again', cls: 'primary', value: 'pending' }, { label: 'Close', value: null }],
      onMount: function (root) {
        root.addEventListener('click', function (ev) {
          var b = ev.target.closest('[data-photo]');
          if (b) openViewer(photoSrc(e.photos[+b.dataset.photo]));
        });
      }
    });
    if (v === 'pending') {
      e.status = 'pending';
      delete e.exportedAt;
      await persistEntries();
      render();
      toast('Moved back to pending');
    }
  }

  /* ------------------------------------------------------------------ */
  /* export                                                              */
  /* ------------------------------------------------------------------ */
  async function openExport() {
    var pend = pendingEntries();
    if (!pend.length) { toast('Nothing to export. Save an action first.'); return; }
    var includeExported = false;
    var selected = {};
    pend.forEach(function (e) { if (!Core.problems(e).length) selected[e.id] = true; });

    function candidates() {
      return includeExported ? state.entries.slice() : pend;
    }
    function listHtml() {
      return candidates().map(function (e) {
        var why = Core.problems(e);
        var blocked = why.length > 0;
        var on = !!selected[e.id];
        return '<button class="pick ' + (on ? 'on' : '') + (blocked ? ' off' : '') + '" data-id="' + esc(e.id) + '">' +
          '<span class="box">' + (on ? 'x' : '') + '</span>' +
          '<span class="t"><b>' + esc(e.caption || 'No caption yet') + '</b>' +
          '<span>' + esc((e.project || 'No project') + (e.area ? ' - ' + e.area : '')) + ', ' + (e.photos || []).length + ' photo(s)</span>' +
          (blocked ? '<br><span class="why">Needs: ' + esc(why.join(', ')) + ' (tap to fix)</span>' : '') +
          '</span></button>';
      }).join('');
    }
    function goLabel() {
      var n = Object.keys(selected).filter(function (k) { return selected[k]; }).length;
      return 'Create ZIP and share (' + n + ')';
    }
    var html = '<label class="toggle"><input type="checkbox" id="inc-exp"> Include already exported actions</label>' +
      '<div id="pick-list">' + listHtml() + '</div>';

    var result = await sheet({
      title: 'Choose what to export', html: html, sticky: true,
      buttons: [{ label: goLabel(), cls: 'primary', value: 'go' }, { label: 'Cancel', value: null }],
      onMount: function (root, close) {
        var goBtn = $('[data-btn="0"]', root);
        function refresh() {
          $('#pick-list', root).innerHTML = listHtml();
          goBtn.textContent = goLabel();
          goBtn.disabled = Object.keys(selected).filter(function (k) { return selected[k]; }).length === 0;
        }
        refresh();
        $('#inc-exp', root).addEventListener('change', function (ev) {
          includeExported = ev.target.checked;
          if (!includeExported) {
            state.entries.forEach(function (e) { if (e.status === 'exported') delete selected[e.id]; });
          }
          refresh();
        });
        $('#pick-list', root).addEventListener('click', function (ev) {
          var b = ev.target.closest('.pick');
          if (!b) return;
          var e = state.entries.find(function (x) { return x.id === b.dataset.id; });
          if (!e) return;
          if (Core.problems(e).length) {
            if (e.status === 'exported') { toast('Make it pending first, then add what is missing.'); return; }
            close({ edit: e.id });
            return;
          }
          selected[e.id] = !selected[e.id];
          refresh();
        });
      }
    });

    if (result && result.edit) {
      var e = state.entries.find(function (x) { return x.id === result.edit; });
      if (e) openForm(e);
      return;
    }
    if (result !== 'go') return;
    var ids = Object.keys(selected).filter(function (k) { return selected[k]; });
    if (ids.length) await runExport(ids);
  }

  async function clearCacheExports() {
    try {
      var r = await FS.readdir({ path: 'export', directory: 'CACHE' });
      var files = (r && r.files) || [];
      for (var i = 0; i < files.length; i++) {
        var nm = files[i].name || files[i];
        try { await FS.deleteFile({ path: 'export/' + nm, directory: 'CACHE' }); } catch (e) { /* ignore */ }
      }
    } catch (e2) { /* folder does not exist yet */ }
  }

  async function runExport(ids) {
    var entries = state.entries
      .filter(function (e) { return ids.indexOf(e.id) >= 0; })
      .sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1; });

    // last safety check
    for (var k = 0; k < entries.length; k++) {
      var why = Core.problems(entries[k]);
      if (why.length) { toast('"' + (entries[k].caption || 'An action') + '" needs: ' + why.join(', ')); return; }
    }

    var now = new Date();
    var b = busy('Preparing ZIP...');
    var uri, name, savedCopy = false;
    try {
      var built = Core.buildManifest(entries, state.settings.device, now);
      var zip = new JSZip();
      zip.file('manifest.json', JSON.stringify(built.manifest, null, 2));
      for (var i = 0; i < built.photoMap.length; i++) {
        var m = built.photoMap[i];
        b.set('Adding photo ' + (i + 1) + ' of ' + built.photoMap.length + '...');
        var data;
        try {
          data = await FS.readFile({ path: m.from, directory: 'DATA' });
        } catch (readErr) {
          throw new Error('A photo file is missing on this phone (' + m.from + '). Open that action and add the photo again.');
        }
        zip.file(m.to, data.data, { base64: true, compression: 'STORE', createFolders: false });
      }
      b.set('Creating file...');
      var b64 = await zip.generateAsync({ type: 'base64', compression: 'STORE' });
      name = Core.zipName(state.settings.device, now);

      await clearCacheExports();
      await FS.writeFile({ path: 'export/' + name, data: b64, directory: 'CACHE', recursive: true });
      try {   // permanent copy for USB transfer
        await FS.writeFile({ path: 'SiteActions/' + name, data: b64, directory: 'DOCUMENTS', recursive: true });
        savedCopy = true;
      } catch (copyErr) { savedCopy = false; }
      var u = await FS.getUri({ path: 'export/' + name, directory: 'CACHE' });
      uri = u.uri;
    } catch (err) {
      b.done();
      await sheet({ title: 'Export failed', html: '<p>' + esc(errText(err)) + '</p><p>Nothing was changed. Your actions are still pending.</p>', buttons: [{ label: 'OK', cls: 'primary', value: true }] });
      return;
    }
    b.done();
    await shareAndConfirm(uri, name, ids, savedCopy);
  }

  async function shareAndConfirm(uri, name, ids, savedCopy) {
    for (;;) {
      try {
        await Share.share({ title: 'Site Actions', text: ids.length + ' site action(s)', files: [uri], dialogTitle: 'Send Site Actions' });
      } catch (e) { /* user closed the share list - still ask below */ }

      var note = '<p><b>' + esc(name) + '</b></p>' +
        '<p>' + (savedCopy ? 'A copy is also saved on this phone in Documents / SiteActions.' : 'Could not save an extra copy on the phone, so only the shared file exists.') + '</p>' +
        '<p>Tap Yes only after you have sent or saved the file. Until then your actions stay pending, so nothing is lost.</p>';
      var v = await sheet({
        title: 'Did the export go through?', html: note, sticky: true,
        buttons: [
          { label: 'Yes, mark as exported', cls: 'primary', value: 'yes' },
          { label: 'Share again', value: 'again' },
          { label: 'No, keep as pending', value: 'no' }
        ]
      });
      if (v === 'again') continue;
      if (v === 'yes') {
        var stamp = new Date().toISOString();
        state.entries.forEach(function (e) {
          if (ids.indexOf(e.id) >= 0) { e.status = 'exported'; e.exportedAt = stamp; }
        });
        await persistEntries();
        render();
        toast(ids.length + ' action(s) marked as exported');
      }
      return;
    }
  }

  /* ------------------------------------------------------------------ */
  /* settings actions                                                    */
  /* ------------------------------------------------------------------ */
  async function listAdd(kind, name) {
    var before = state.settings[kind].length;
    state.settings[kind] = Core.addToList(state.settings[kind], name);
    if (state.settings[kind].length === before) { toast(String(name).trim() ? 'Already in the list' : 'Type a name first'); return; }
    await persistSettings();
    render();
  }

  async function listMerge(kind, text) {
    var incoming = Core.parseList(text);
    var list = state.settings[kind], added = 0;
    incoming.forEach(function (n) {
      var next = Core.addToList(list, n);
      if (next.length !== list.length) { list = next; added++; }
    });
    state.settings[kind] = list;
    await persistSettings();
    render();
    toast(added + ' name(s) added');
  }

  async function handleListAction(act, kind, i) {
    var list = state.settings[kind];
    if (act === 'list-rename') {
      var nv = await promptBox('Rename', 'New name', list[i]);
      if (!nv || nv === list[i]) return;
      if (list.some(function (x, j) { return j !== i && x.toLowerCase() === nv.toLowerCase(); })) { toast('That name is already in the list'); return; }
      list[i] = nv;
      await persistSettings();
      render();
    } else if (act === 'list-del') {
      var ok = await confirmBox('Delete "' + list[i] + '"?', 'Actions already saved keep this name. It only leaves the drop-down list.', 'Delete', true);
      if (!ok) return;
      list.splice(i, 1);
      await persistSettings();
      render();
    } else if (act === 'list-paste') {
      var v = await sheet({
        title: 'Paste a list', row: true,
        html: '<div class="field"><label for="paste-box">One name per line</label><textarea id="paste-box" style="min-height:180px"></textarea></div>',
        buttons: [{ label: 'Cancel', value: 'no' }, { label: 'Add names', cls: 'primary', value: 'ok' }],
        onMount: function (root) {
          root.addEventListener('click', function (ev) {
            var b = ev.target.closest('[data-btn]');
            if (b) state._paste = $('#paste-box', root).value;
          }, true);
        }
      });
      if (v === 'ok') await listMerge(kind, state._paste);
    } else if (act === 'list-file') {
      var inp = $('#file-' + kind);
      if (inp) { inp.value = ''; inp.click(); }
    }
  }

  async function clearExported() {
    var n = state.entries.filter(function (e) { return e.status === 'exported'; }).length;
    var ok = await confirmBox('Delete ' + n + ' exported action(s)?', 'Only do this after Site Register has imported them. This cannot be undone.', 'Delete', true);
    if (!ok) return;
    var keep = [];
    state.entries.forEach(function (e) {
      if (e.status === 'exported') (e.photos || []).forEach(function (p) { deletePhoto(p); });
      else keep.push(e);
    });
    state.entries = keep;
    await persistEntries();
    render();
    toast('Exported actions deleted');
  }

  /* ------------------------------------------------------------------ */
  /* events                                                              */
  /* ------------------------------------------------------------------ */
  function onClick(ev) {
    var t = ev.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act = t.dataset.act;
    switch (act) {
      case 'settings': state.view = 'settings'; render(); break;
      case 'settings-back': state.view = 'home'; render(); break;
      case 'filter': state.filter = t.dataset.f; render(); break;
      case 'new': openForm(null); break;
      case 'export': openExport(); break;
      case 'open': {
        var e = state.entries.find(function (x) { return x.id === t.dataset.id; });
        if (!e) break;
        if (e.status === 'exported') showDetail(e); else openForm(e);
        break;
      }
      case 'form-back': leaveForm(false); break;
      case 'form-save': saveForm(); break;
      case 'form-delete':
        confirmBox('Delete this action?', 'The photos and text will be removed from this phone.', 'Delete', true).then(async function (ok) {
          if (!ok) return;
          var f = state.form;
          for (var i = 0; i < f.added.length; i++) await deletePhoto(f.added[i]);
          await deleteEntry(f.entry.id);
          state.form = null; state.view = 'home'; render();
          toast('Deleted');
        });
        break;
      case 'pri':
        state.form.entry.priority = t.dataset.p;
        $all('#pri-seg button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.p === t.dataset.p)); });
        break;
      case 'take': addPhotos('camera'); break;
      case 'gallery': addPhotos('gallery'); break;
      case 'rm-photo': removePhoto(+t.dataset.i); break;
      case 'view-photo': openViewer(photoSrc(state.form.entry.photos[+t.dataset.i])); break;
      case 'list-add': {
        var inp = $('#add-' + t.dataset.kind);
        listAdd(t.dataset.kind, inp ? inp.value : '');
        break;
      }
      case 'list-rename': case 'list-del': case 'list-paste': case 'list-file':
        handleListAction(act, t.dataset.kind, +t.dataset.i);
        break;
      case 'clear-exported': clearExported(); break;
    }
  }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  async function onFieldChange(ev) {
    var t = ev.target;
    if (t.dataset && t.dataset.f && state.form) {
      var field = t.dataset.f;
      if (t.tagName === 'SELECT' && t.value === '__new__') {
        var kind = field === 'project' ? 'projects' : 'assignees';
        var name = await promptBox(field === 'project' ? 'New project' : 'New person', 'Name', '');
        if (name) {
          state.settings[kind] = Core.addToList(state.settings[kind], name);
          var match = state.settings[kind].find(function (x) { return x.toLowerCase() === name.toLowerCase(); });
          state.form.entry[field] = match;
          await persistSettings();
        }
        // redraw the drop-down only, so typed text and photos are untouched
        t.innerHTML = optionList(state.settings[kind], state.form.entry[field], field === 'project' ? 'Choose project...' : 'Nobody yet');
        return;
      }
      state.form.entry[field] = t.value;
    } else if (t.dataset && t.dataset.s) {
      var key = t.dataset.s;
      state.settings[key] = (key === 'device') ? t.value : Number(t.value);
      persistSettings();
    } else if (t.type === 'file' && t.dataset.kind && t.files && t.files[0]) {
      var kindF = t.dataset.kind;
      var reader = new FileReader();
      reader.onload = function () { listMerge(kindF, String(reader.result || '')); };
      reader.onerror = function () { toast('Could not read that file'); };
      reader.readAsText(t.files[0]);
    }
  }

  function onBack() {
    var top = overlays[overlays.length - 1];
    if (top) { if (!top.locked) top.close(); return; }
    if (state.view === 'form') { leaveForm(false); return; }
    if (state.view === 'settings') { state.view = 'home'; render(); return; }
    if (AppPlugin && AppPlugin.exitApp) AppPlugin.exitApp();
  }

  /* ------------------------------------------------------------------ */
  /* start                                                               */
  /* ------------------------------------------------------------------ */
  async function init() {
    var app = $('#app');
    if (!FS || !Prefs || !Cam || !Share) {
      app.innerHTML = '<div class="empty-state"><strong>Open this from the installed Android app</strong>' +
        'The phone features (camera, files, share) are not available in a normal browser.</div>';
      return;
    }
    app.addEventListener('click', onClick);
    app.addEventListener('change', onFieldChange);
    app.addEventListener('input', function (ev) {          // keep text fields live without redrawing
      var t = ev.target;
      if (state.form && t.dataset && t.dataset.f && t.tagName !== 'SELECT') state.form.entry[t.dataset.f] = t.value;
      if (t.dataset && t.dataset.s === 'device') { state.settings.device = t.value; }
    });

    state.settings = Object.assign(defaultSettings(), await readJSON(KEY_SETTINGS, {}));
    state.entries = await readJSON(KEY_ENTRIES, [], KEY_ENTRIES_BAK);

    try {
      await FS.mkdir({ path: 'photos', directory: 'DATA', recursive: true });
    } catch (e) { /* already exists */ }
    try {
      var u = await FS.getUri({ path: 'photos', directory: 'DATA' });
      state.baseUri = u.uri.replace(/\/photos\/?$/, '');
    } catch (e2) { state.baseUri = ''; }

    render();
    if (AppPlugin && AppPlugin.addListener) AppPlugin.addListener('backButton', onBack);
  }

  // exposed for the PC test only
  window.SA = {
    state: state, init: init, render: render, onBack: onBack,
    _setCompress: function (fn) { compressFn = fn; }
  };
  if (!window.__SA_NO_AUTOINIT) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})();
