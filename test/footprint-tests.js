// Replays the 2026-10-26 field log against the building outlines. Run: node test/footprint-tests.js
const vm = require('vm'), fs = require('fs'), path = require('path');
const ctx = { console, navigator: {}, document: {}, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} } };
ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/ar.js'), 'utf8'), ctx);
const reg = {}; const w = { VENUES: {}, __venueHelpers: { gpsNode: (id, label) => ({ id, label }) }, registerVenue: (v) => { reg[v.id] = v; } };
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/venues/outdoor-hostels.js'), 'utf8'), Object.assign(vm.createContext(Object.assign({}, w, { window: w })), {}));
const nodes = Object.fromEntries(reg.outdoor_hostels.nodes.map((n) => [n.id, n]));
const view = ctx.ArOverlay.footprintView;
let pass = 0, fail = 0;
const check = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + x)); };
const inSpan = (h, v) => ((h - v.lo + 720) % 360) <= v.width;
// [building node id, lat, lon, sensor heading the user actually faced]
const rows = [
  ['hostel_g', 12.9681858, 79.1595742, 88.3],
  ['hostel_h', 12.968139, 79.1595688, 190.9],
  ['hostel_h', 12.9680969, 79.1595908, 191.1],
  ['hostel_h', 12.9682411, 79.1594597, 184.0],
  ['hostel_j', 12.968131, 79.1594121, 255.4],
];
for (const [id, la, lo, h] of rows) {
  check(`${id} outline exists`, Array.isArray(nodes[id].footprint) && nodes[id].buildingName);
  const v = view(la, lo, nodes[id].footprint);
  check(`${nodes[id].buildingName}: facing ${h} is inside its outline from (${la},${lo})`, v && !v.inside && inSpan(h, v), JSON.stringify(v));
}
check('no outline -> null', view(12.968, 79.159, null) === null);
check('standing inside the outline -> inside flag', view(12.96815, 79.15965, nodes.hostel_g.footprint)?.inside === true);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
