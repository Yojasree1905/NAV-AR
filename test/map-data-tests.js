// Run: node test/map-data-tests.js
// Holds the project's hard-coded map data to the OSM survey in
// map-hostels.osm: walkway node coordinates and edges, which building each
// destination belongs to, the convenience store position, and the route
// instructions the app speaks. When the survey changes, replace the .osm file
// and this shows exactly which constants went stale.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const check = (n, c, x) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + x : ''))); };

// ---- tiny OSM parser (no dependencies) ----
const osm = read('map-hostels.osm');
const nodes = {};
for (const m of osm.matchAll(/<node id="(\d+)"[^>]*?lat="([\d.]+)" lon="([\d.]+)"/g)) nodes[m[1]] = [parseFloat(m[2]), parseFloat(m[3])];
const ways = [];
for (const m of osm.matchAll(/<way id="(\d+)"[^>]*>([\s\S]*?)<\/way>/g)) {
  const tags = {};
  for (const t of m[2].matchAll(/<tag k="([^"]*)" v="([^"]*)"/g)) tags[t[1]] = t[2];
  ways.push({ id: m[1], refs: [...m[2].matchAll(/<nd ref="(\d+)"/g)].map((x) => x[1]), tags });
}
const dist = (a, b) => { const p = Math.PI / 180, R = 6371000; return R * Math.hypot((b[1] - a[1]) * p * Math.cos((a[0] + b[0]) / 2 * p), (b[0] - a[0]) * p); };
const centroid = (w) => { const pts = w.refs.slice(0, -1).map((r) => nodes[r]); return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length]; };
const buildings = ways.filter((w) => w.tags.building && w.tags.name).map((w) => ({ name: w.tags.name, ways: w, c: centroid(w) }));
const nearestBuilding = (p) => buildings.map((b) => ({ name: b.name, d: dist(p, b.c) })).sort((a, b) => a.d - b.d)[0];

// ---- pull the constants out of the source files ----
const grab = (file, constName) => {
  const src = read(file);
  const i = src.indexOf(`const ${constName} =`);
  if (i < 0) throw new Error(`${constName} not found in ${file}`);
  const open = src.indexOf(src[src.indexOf('=', i) + 2], i); // '{' or '['
  let depth = 0, j = open;
  for (; j < src.length; j++) { if ('{['.includes(src[j])) depth++; if ('}]'.includes(src[j])) { depth--; if (!depth) break; } }
  return vm.runInNewContext('(' + src.slice(open, j + 1) + ')');
};
const WALK = grab('js/route-provider.js', 'CAMPUS_WALK_NODES');
const EDGES = grab('js/route-provider.js', 'CAMPUS_WALK_EDGES');
const COORDS = grab('js/venues/outdoor-hostels.js', 'CALIBRATED_COORDS');
const POIS = grab('js/map-discovery.js', 'CAMPUS_SURVEYED_POIS');

console.log('walkway nodes match the survey');
for (const [id, n] of Object.entries(WALK)) {
  const o = nodes[id];
  check(`${id} ${n.name}: exists in OSM and within 1 m`, !!o && dist([n.lat, n.lon], o) < 1, o ? dist([n.lat, n.lon], o).toFixed(1) + ' m off' : 'missing');
}

console.log('walkway edges follow real paths');
const consecutive = new Set();
for (const w of ways.filter((x) => x.tags.highway)) for (let i = 0; i < w.refs.length - 1; i++) { consecutive.add(w.refs[i] + '-' + w.refs[i + 1]); consecutive.add(w.refs[i + 1] + '-' + w.refs[i]); }
for (const [a, b] of EDGES) check(`edge ${a} - ${b} is a real OSM path segment`, consecutive.has(a + '-' + b));
for (const k of consecutive) {
  const [a, b] = k.split('-');
  if (WALK[a] && WALK[b] && a < b) check(`OSM segment ${a} - ${b} is in the graph`, EDGES.some(([x, y]) => (x === a && y === b) || (x === b && y === a)));
}

console.log('destinations belong to the right buildings');
const gEntry = [COORDS.hostel_g.lat, COORDS.hostel_g.lon], hEntry = [COORDS.hostel_h.lat, COORDS.hostel_h.lon];
check('G Block point is nearest the G Block building', nearestBuilding(gEntry).name === 'G Block', JSON.stringify(nearestBuilding(gEntry)));
check('H Block point is nearest the H Block building', nearestBuilding(hEntry).name === 'H Block', JSON.stringify(nearestBuilding(hEntry)));
check('G and H points are within 30 m of their buildings', nearestBuilding(gEntry).d < 30 && nearestBuilding(hEntry).d < 30);
const jLift = nodes['14168860238'];
check('J Block lift point is the OSM node on the J Block outline', jLift && dist(jLift, [COORDS.hostel_j.lat, COORDS.hostel_j.lon]) < 1);
check('J main entrance is 14165878671 on the path network', dist(nodes['14165878671'], [COORDS.j_main_entrance.lat, COORDS.j_main_entrance.lon]) < 1);
check('hostel gate is OSM node 14165878674', dist(nodes['14165878674'], [COORDS.main_gate.lat, COORDS.main_gate.lon]) < 1);

console.log('convenience store');
const shop = buildings.find((b) => /convin?ience/i.test(b.name));
const store = [COORDS.convenience_store.lat, COORDS.convenience_store.lon];
check('store building exists in the survey', !!shop);
check('stored point is within 10 m of the store building', dist(store, shop.c) < 10, dist(store, shop.c).toFixed(1) + ' m');
check('store is within 15 m of J Block main entrance', dist(store, [COORDS.j_main_entrance.lat, COORDS.j_main_entrance.lon]) < 15);
check('store is within 25 m of the hostel gate', dist(store, [COORDS.main_gate.lat, COORDS.main_gate.lon]) < 25);
check('store is far (> 50 m) from H Block, as on the ground', dist(store, hEntry) > 50, dist(store, hEntry).toFixed(0) + ' m');
const hPoi = POIS.find((p) => p.name === 'Convenience Store');
check('map-discovery uses the same store point', hPoi && dist([hPoi.lat, hPoi.lon], store) < 0.5);

console.log('POI table agrees with venue coordinates');
const byName = { 'G Block': COORDS.hostel_g, 'H Block': COORDS.hostel_h, 'J Block Lift Entrance': COORDS.hostel_j, 'Hostel Gate': COORDS.main_gate, 'J Block Main Entrance': COORDS.j_main_entrance };
for (const p of POIS) if (byName[p.name]) check(`${p.name} identical in both files`, dist([p.lat, p.lon], [byName[p.name].lat, byName[p.name].lon]) < 0.5);

console.log('spoken routes');
const ctx = vm.createContext({ window: {}, console, fetch: () => { throw new Error('network'); }, setTimeout, localStorage: undefined });
vm.runInContext(read('js/route-provider.js'), ctx);
const rp = vm.runInContext('new RouteProvider({provider:"osrm"})', ctx);
(async () => {
  const from = { lat: COORDS.main_gate.lat, lon: COORDS.main_gate.lon };
  const r1 = await rp.getWalkingRoute(from, { lat: store[0], lon: store[1], name: 'Convenience Store' });
  check('gate -> store: says "Convenience Store", not a nearby node name', r1 && /Convenience Store/.test(r1.steps[0].instruction), r1 && r1.steps[0].instruction);
  check('gate -> store is short (< 40 m)', r1 && r1.distanceMeters < 40, r1 && r1.distanceMeters.toFixed(0));
  const r2 = await rp.getWalkingRoute(from, { lat: hEntry[0], lon: hEntry[1], name: 'H Block' });
  check('gate -> H Block: says "H Block" (used to say "G Block North Entrance")', r2 && /H Block/.test(r2.steps[0].instruction) && !/G Block/.test(r2.steps[0].instruction), r2 && r2.steps[0].instruction);
  const r3 = await rp.getWalkingRoute(from, { lat: gEntry[0], lon: gEntry[1], name: 'G Block' });
  check('gate -> G Block: says "G Block"', r3 && /G Block/.test(r3.steps[0].instruction) && !/H Block/.test(r3.steps[0].instruction), r3 && r3.steps[0].instruction);
  const r4 = await rp.getWalkingRoute({ lat: COORDS.j_main_entrance.lat, lon: COORDS.j_main_entrance.lon }, { lat: store[0], lon: store[1], name: 'Convenience Store' });
  check('J main entrance -> store is very short (< 15 m)', r4 && r4.distanceMeters < 15, r4 && r4.distanceMeters.toFixed(0));
  const segs = (r2 ? r2.points : []).slice(1).map((p, i) => dist(r2.points[i], p));
  check('no route segment jumps more than 120 m', segs.length && Math.max(...segs) < 120, Math.max(...segs).toFixed(0));
  const r5 = await rp.getWalkingRoute(from, { lat: 12.9683, lon: 79.1595 });
  check('no destination name -> falls back to a node name, never "undefined"', r5 && !/undefined/.test(r5.steps[0].instruction), r5 && r5.steps[0].instruction);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
