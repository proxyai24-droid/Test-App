// Run with:  node test/core.test.js
// Checks the ZIP contract (manifest.json) against the format Site Register imports.
const assert = require('assert');
const Core = require('../www/js/core.js');

const entries = [{
  id: '11111111-1111-4111-8111-111111111111', createdAt: '2026-10-08T05:30:00.000Z',
  project: ' Zentral JLT ', area: 'Level 3 ', priority: 'High', caption: ' Fix cable tray ',
  assignee: 'Ahmed', dueDate: '2026-10-12', photos: ['photos/a_x1.jpg', 'photos/a_x2.jpg']
}, {
  id: '22222222-2222-4222-8222-222222222222', createdAt: '2026-10-08T06:00:00.000Z',
  project: 'G37', area: '', priority: 'bogus', caption: 'Paint touch-up',
  assignee: '', dueDate: '', photos: ['photos/b_y1.jpg']
}];

const { manifest, photoMap } = Core.buildManifest(entries, 'Ahmed - Pixel', new Date('2026-10-08T07:00:00Z'), 'exp-1');

assert.deepStrictEqual(Object.keys(manifest), ['format', 'version', 'exportId', 'exportedAt', 'device', 'entries']);
assert.strictEqual(manifest.format, 'site-actions');
assert.strictEqual(manifest.version, 1);
assert.strictEqual(manifest.exportId, 'exp-1');
assert.strictEqual(manifest.exportedAt, '2026-10-08T07:00:00.000Z');
assert.strictEqual(manifest.device, 'Ahmed - Pixel');

assert.deepStrictEqual(Object.keys(manifest.entries[0]),
  ['id', 'createdAt', 'project', 'area', 'priority', 'caption', 'assignee', 'dueDate', 'photos']);
assert.strictEqual(manifest.entries[0].project, 'Zentral JLT');       // trimmed
assert.strictEqual(manifest.entries[0].caption, 'Fix cable tray');    // trimmed
assert.deepStrictEqual(manifest.entries[0].photos,
  ['photos/11111111-1111-4111-8111-111111111111_1.jpg', 'photos/11111111-1111-4111-8111-111111111111_2.jpg']);
assert.strictEqual(manifest.entries[1].priority, 'Medium');           // invalid -> default
assert.strictEqual(manifest.entries[1].assignee, '');                 // empty string, not null
assert.strictEqual(manifest.entries[1].dueDate, '');
assert.strictEqual(photoMap.length, 3);
assert.deepStrictEqual(photoMap[0], { from: 'photos/a_x1.jpg', to: 'photos/11111111-1111-4111-8111-111111111111_1.jpg' });

// empty device -> "Phone"
assert.strictEqual(Core.buildManifest(entries, '  ', new Date()).manifest.device, 'Phone');

// file name
assert.strictEqual(Core.zipName('Ahmed - Pixel', new Date(2026, 9, 8, 14, 5)), 'SiteActions_Ahmed_Pixel_20261008_1405.zip');
assert.strictEqual(Core.zipName('', new Date(2026, 0, 2, 3, 4)), 'SiteActions_Phone_20260102_0304.zip');

// validation
assert.deepStrictEqual(Core.problems(entries[0]), []);
assert.deepStrictEqual(Core.problems({ photos: [], caption: ' ', project: '' }), ['no photo', 'no caption', 'no project']);

// lists
assert.deepStrictEqual(Core.parseList('\uFEFFA\r\n b \n\nA\nC'), ['A', 'b', 'C']);
assert.deepStrictEqual(Core.addToList(['Zentral'], 'zentral'), ['Zentral']);
assert.deepStrictEqual(Core.addToList(['Zentral'], ' G37 '), ['Zentral', 'G37']);

// uuid shape
assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(Core.uuid()));
assert.notStrictEqual(Core.uuid(), Core.uuid());

console.log('core tests passed');
