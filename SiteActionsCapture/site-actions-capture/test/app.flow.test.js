// Simulated-phone test: runs the real app.js in jsdom with fake Capacitor plugins.
// Run with:  node test/app.flow.test.js   (needs jsdom: see test/README in the notes)
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require(process.env.JSDOM_PATH || 'jsdom');

const root = path.join(__dirname, '..', 'www');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const JSZipNode = require('jszip');

(async () => {
  const dom = new JSDOM(read('index.html').replace(/<script[^>]*><\/script>/g, ''),
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  w.__SA_NO_AUTOINIT = true;

  // ---- fake phone ----
  const disk = {}, prefs = {}, shared = [];
  const key = (d, p) => d + ':' + p;
  w.Capacitor = {
    convertFileSrc: (u) => u.replace('file://', 'http://localhost/_capacitor_file_'),
    Plugins: {
      Filesystem: {
        async mkdir() {},
        async writeFile({ path, data, directory }) { disk[key(directory, path)] = data; },
        async readFile({ path, directory }) {
          if (!(key(directory, path) in disk)) throw new Error('File does not exist');
          return { data: disk[key(directory, path)] };
        },
        async deleteFile({ path, directory }) { delete disk[key(directory, path)]; },
        async readdir({ path, directory }) {
          const pre = key(directory, path + '/');
          return { files: Object.keys(disk).filter(k => k.startsWith(pre)).map(k => ({ name: k.slice(pre.length) })) };
        },
        async getUri({ path, directory }) { return { uri: 'file:///data/user/0/app/' + directory.toLowerCase() + '/' + path }; }
      },
      Preferences: {
        async get({ key }) { return { value: key in prefs ? prefs[key] : null }; },
        async set({ key, value }) { prefs[key] = value; }
      },
      Camera: { async takePhoto() { return { webPath: 'http://localhost/_capacitor_file_/cache/shot.jpg' }; },
                async chooseFromGallery() { return { results: [] }; } },
      Share: { async share(o) { shared.push(o); } },
      App: { addListener() {}, exitApp() { w.__exited = true; } }
    }
  };
  // jsdom cannot run JSZip's browser scheduler, so the test hands the app Node's build of the same library.
  w.JSZip = JSZipNode;
  w.eval(read('js/core.js'));
  w.eval(read('js/app.js'));
  w.SA._setCompress(async () => Buffer.from('FAKE-JPEG-BYTES').toString('base64'));

  const d = w.document;
  const tick = (ms = 25) => new Promise(r => setTimeout(r, ms));
  const click = async (sel) => { const el = d.querySelector(sel); assert.ok(el, 'missing ' + sel); el.click(); await tick(); };
  const setVal = async (sel, v, ev = 'input') => {
    const el = d.querySelector(sel); assert.ok(el, 'missing ' + sel); el.value = v;
    el.dispatchEvent(new w.Event(ev, { bubbles: true })); await tick();
  };
  const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await tick(25); };
  const sheetBtn = async (i) => { await click('.scrim [data-btn="' + i + '"]'); await tick(40); };

  await w.SA.init(); await tick();
  assert.ok(d.body.textContent.includes('First, add your project names'), 'first-run notice');

  // ---- settings: projects, people, device ----
  await click('[data-act="settings"]');
  await setVal('#s-device', 'Ahmed - Pixel', 'change');
  await setVal('#add-projects', 'Zentral JLT'); await click('[data-act="list-add"][data-kind="projects"]');
  await setVal('#add-projects', 'G37'); await click('[data-act="list-add"][data-kind="projects"]');
  await setVal('#add-assignees', 'Khalid'); await click('[data-act="list-add"][data-kind="assignees"]');
  assert.strictEqual(JSON.stringify(w.SA.state.settings.projects), JSON.stringify(['Zentral JLT', 'G37']));
  await click('[data-act="settings-back"]');

  // ---- entry 1: complete ----
  await click('[data-act="new"]');
  await setVal('#f-project', 'Zentral JLT', 'change');
  await setVal('#f-area', 'Level 3, Kitchen');
  await click('[data-act="take"]'); await tick(60);
  await setVal('#f-caption', 'Fix the cable tray support');
  await click('[data-act="pri"][data-p="High"]');
  await setVal('#f-assignee', 'Khalid', 'change');
  await setVal('#f-due', '2026-10-12');
  await click('[data-act="form-save"]');
  assert.strictEqual(w.SA.state.entries.length, 1);
  const e1 = w.SA.state.entries[0];
  assert.strictEqual(e1.project, 'Zentral JLT'); assert.strictEqual(e1.priority, 'High');
  assert.strictEqual(e1.assignee, 'Khalid'); assert.strictEqual(e1.photos.length, 1);
  assert.ok(disk['DATA:' + e1.photos[0]], 'photo stored in private storage');
  assert.ok(JSON.parse(prefs.sa_entries).length === 1, 'entry persisted');

  // ---- entry 2: incomplete (no photo) -> must block export ----
  await click('[data-act="new"]');
  assert.strictEqual(d.querySelector('#f-project').value, 'Zentral JLT', 'remembers last project');
  assert.strictEqual(d.querySelector('#f-area').value, 'Level 3, Kitchen', 'remembers last area');
  await setVal('#f-caption', 'No photo yet');
  await click('[data-act="form-save"]');
  assert.strictEqual(w.SA.state.entries.length, 2);
  assert.ok(d.body.textContent.includes('Incomplete'));

  // ---- export ----
  await click('[data-act="export"]');
  assert.ok(d.querySelector('.pick.off'), 'incomplete entry is blocked');
  assert.ok(d.querySelector('.scrim').textContent.includes('no photo'));
  await sheetBtn(0);                       // Create ZIP and share (1)
  await waitFor(() => shared.length === 1);
  assert.strictEqual(shared.length, 1, 'share sheet opened');
  assert.strictEqual(w.SA.state.entries.find(e => e.id === e1.id).status, 'pending', 'still pending before confirmation');

  const zipKey = Object.keys(disk).find(k => k.startsWith('CACHE:export/'));
  assert.ok(/SiteActions_Ahmed_Pixel_\d{8}_\d{4}\.zip$/.test(zipKey), zipKey);
  assert.ok(Object.keys(disk).some(k => k.startsWith('DOCUMENTS:SiteActions/')), 'extra copy kept');
  const zip = await JSZipNode.loadAsync(Buffer.from(disk[zipKey], 'base64'));
  const names = Object.keys(zip.files).sort();
  assert.deepStrictEqual(names, ['manifest.json', 'photos/' + e1.id + '_1.jpg']);
  const m = JSON.parse(await zip.file('manifest.json').async('string'));
  assert.strictEqual(m.format, 'site-actions'); assert.strictEqual(m.version, 1);
  assert.strictEqual(m.device, 'Ahmed - Pixel'); assert.strictEqual(m.entries.length, 1);
  assert.deepStrictEqual(m.entries[0], {
    id: e1.id, createdAt: e1.createdAt, project: 'Zentral JLT', area: 'Level 3, Kitchen', priority: 'High',
    caption: 'Fix the cable tray support', assignee: 'Khalid', dueDate: '2026-10-12', photos: ['photos/' + e1.id + '_1.jpg']
  });
  assert.strictEqual(await zip.file(names[1]).async('string'), 'FAKE-JPEG-BYTES');

  // "Did the export go through?" -> No keeps pending, then Yes marks exported
  assert.ok(d.querySelector('.scrim').textContent.includes('Did the export go through?'));
  await sheetBtn(2);                        // No, keep as pending
  assert.strictEqual(w.SA.state.entries.find(e => e.id === e1.id).status, 'pending');
  await click('[data-act="export"]'); await sheetBtn(0); await waitFor(() => shared.length === 2);
  await sheetBtn(0);                        // Yes, mark as exported
  const after = w.SA.state.entries.find(e => e.id === e1.id);
  assert.strictEqual(after.status, 'exported'); assert.ok(after.exportedAt);
  assert.strictEqual(JSON.parse(prefs.sa_entries).find(e => e.id === e1.id).status, 'exported', 'status persisted');

  // exported entries open read-only; can be made pending again
  await click('.entry[data-id="' + e1.id + '"]');
  assert.ok(d.querySelector('.scrim').textContent.includes('Exported action'));
  await sheetBtn(0);
  assert.strictEqual(w.SA.state.entries.find(e => e.id === e1.id).status, 'pending');

  // ---- edit/delete + photo removal cleans files ----
  await click('.entry[data-id="' + e1.id + '"]');
  await click('[data-act="rm-photo"][data-i="0"]');
  await click('[data-act="form-save"]');
  assert.ok(!disk['DATA:' + e1.photos[0]], 'removed photo deleted from storage');
  await click('.entry[data-id="' + e1.id + '"]');
  await click('[data-act="form-delete"]'); await sheetBtn(1); await tick(40);
  assert.strictEqual(w.SA.state.entries.length, 1);

  // ---- cancel discards photos taken but not saved ----
  await click('[data-act="new"]'); await click('[data-act="take"]'); await tick(60);
  const before = Object.keys(disk).filter(k => k.startsWith('DATA:photos/')).length;
  assert.strictEqual(before, 1);
  w.SA.onBack(); await tick(40);            // back button -> discard dialog
  await sheetBtn(1); await tick(40);
  assert.strictEqual(Object.keys(disk).filter(k => k.startsWith('DATA:photos/')).length, 0, 'unsaved photo cleaned up');
  assert.strictEqual(w.SA.state.view, 'home');

  // ---- restart: data survives ----
  w.SA.state.entries = []; w.SA.state.settings = {};
  await w.SA.init(); await tick();
  assert.strictEqual(w.SA.state.entries.length, 1, 'entries reloaded after restart');
  assert.strictEqual(JSON.stringify(w.SA.state.settings.projects), JSON.stringify(['Zentral JLT', 'G37']));

  console.log('app flow tests passed');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e && e.stack || e); process.exit(1); });
