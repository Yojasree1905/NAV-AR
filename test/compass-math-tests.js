// Checks the sensor-API quaternion -> camera heading maths against the W3C
// alpha/beta/gamma definition. The earlier formula was 90 degrees off.
// Run: node test/compass-math-tests.js
const vm = require('vm'), fs = require('fs'), path = require('path');
const ctx = { window: {}, document: {}, console, navigator: {} };
ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/ar.js'), 'utf8'), ctx);
const toHeading = ctx.ArOverlay.quaternionToHeadingDeg;

const d = Math.PI / 180;
function quat(a, b, g) { // R = Rz(a) Rx(b) Ry(g)
  const cz = Math.cos(a*d/2), sz = Math.sin(a*d/2), cx = Math.cos(b*d/2), sx = Math.sin(b*d/2), cy = Math.cos(g*d/2), sy = Math.sin(g*d/2);
  const m = (p, q) => [p[3]*q[0]+p[0]*q[3]+p[1]*q[2]-p[2]*q[1], p[3]*q[1]-p[0]*q[2]+p[1]*q[3]+p[2]*q[0], p[3]*q[2]+p[0]*q[1]-p[1]*q[0]+p[2]*q[3], p[3]*q[3]-p[0]*q[0]-p[1]*q[1]-p[2]*q[2]];
  return m(m([0,0,sz,cz],[sx,0,0,cx]),[0,sy,0,cy]);
}
const diff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
let pass = 0, fail = 0;
function check(name, ok) { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name); }

// Upright phone (camera on the horizon): camera heading is 360 - alpha.
for (const alpha of [0, 45, 90, 180, 270, 300, 359]) {
  for (const [b, g] of [[90, 0], [80, 5], [100, -8], [70, 0]]) {
    const got = toHeading(quat(alpha, b, g));
    const want = (360 - alpha) % 360;
    check(`alpha ${alpha} beta ${b} gamma ${g}: ${got.toFixed(1)} ~ ${want}`, diff(got, want) < 20 && (b !== 90 || diff(got, want) < 0.5));
  }
}
// Flat phone, top of phone toward alpha-defined north: use the top axis.
check('flat, top facing north = 0', diff(toHeading(quat(0, 0, 0)), 0) < 0.5);
check('flat, top facing east (alpha 270) = 90', diff(toHeading(quat(270, 0, 0)), 90) < 0.5);
check('malformed reading -> null', toHeading(null) === null && toHeading([NaN, 0, 0, 1]) === null);
// --- field calibration + log ---
ctx.localStorage = { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } };
const ar = Object.create(ctx.ArOverlay.prototype);
Object.assign(ar, { heading: 79, hasLiveHeading: true, _headingAt: Date.now(), headingSource: 'sensor-api', compassOffset: 0, fieldLog: [], currentLat: 12.9680, currentLon: 79.1594, gpsAccuracy: 8 });
// G Block entrance is ~36 degrees from here; sensor says 79 -> correction about -43
const r = ar.calibrateTo(12.9681514, 79.1595125);
check(`align: bearing ${r.bearing.toFixed(0)} raw 79 offset ${r.offset.toFixed(0)}`, r.ok && Math.abs(r.bearing - 79 - r.offset) < 0.01 && r.offset < -30 && r.offset > -50);
check('offset is session-only (not stored)', ctx.localStorage.getItem('navassist_compass_offset') === null);
const rec = ar.logReading('G Block', 12.9681514, 79.1595125);
check('log records error + offset', rec && rec.facing === 'G Block' && Math.abs(rec.errorDeg - r.offset) < 0.2 && rec.calibrationOffset === Math.round(r.offset * 10) / 10 && ar.fieldLog.length === 1);
ar.gpsAccuracy = null;
check('unknown GPS accuracy refuses log and align', ar.logReading('x', 12.9681514, 79.1595125) === null && !ar.calibrateTo(12.9681514, 79.1595125).ok);
ar.gpsAccuracy = 40;
check('weak GPS (40 m) refuses', /too weak/.test(ar.calibrateTo(12.9681514, 79.1595125).reason));
ar.gpsAccuracy = 8;
const keepLat = ar.currentLat; ar.setBuildingList([{ name: 'x' }]);
check('setBuildingList does not move the user', ar.currentLat === keepLat && ar.nearbyBuildings.length === 1);
ar.resetCalibration();
check('reset clears', ar.compassOffset === 0);
// aligning to a building outline while already facing it must NOT add a correction
const gFoot = [[12.9681514, 79.159575], [12.9681514, 79.15985], [12.96835, 79.15985], [12.96835, 79.159575]];
ar.currentLat = 12.9680; ar.currentLon = 79.1594; ar.heading = 40; ar._headingAt = Date.now();
const vv = ctx.ArOverlay.footprintView(12.9680, 79.1594, gFoot);
const rr = ar.calibrateTo(12.96825, 79.15971, gFoot);
check(`facing inside outline (${vv.lo.toFixed(0)}-${(vv.lo + vv.width).toFixed(0)}) -> offset 0`, rr.ok && rr.offset === 0 && rr.insideOutline === true, JSON.stringify(rr));
ar._headingAt = Date.now() - 5000;
check('stale compass refuses to align/log', !ar.calibrateTo(12.9681514, 79.1595125).ok && ar.logReading('x', 1, 1) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
