// Ground-plane projection of the route ribbon. Run: node test/path-tests.js
const vm = require('vm'), fs = require('fs'), path = require('path');
const ctx = { console, navigator: {}, document: {}, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} } };
ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/ar.js'), 'utf8'), ctx);
const gp = ctx.ArOverlay.groundPath;
let pass = 0, fail = 0;
const check = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + x)); };
const LAT = 12.968, LON = 79.1594, MLAT = 1 / 111320, MLON = 1 / (111320 * Math.cos(LAT * Math.PI / 180));
const at = (northM, eastM) => [LAT + northM * MLAT, LON + eastM * MLON];
const o = { w: 412, horizonY: 330, footY: 600, fovH: 60, maxDist: 150 };
const W = 412;

// straight north, camera facing north
let r = gp([at(0, 0), at(10, 0), at(20, 0), at(40, 0)], LAT, LON, 0, o);
check('straight ahead: ribbon is centred', r.points.length >= 3 && r.points.every((p) => Math.abs(p.x - W / 2) < 2), JSON.stringify(r.points.slice(0, 3)));
check('straight ahead: rises toward the horizon and narrows', r.points.every((p, i, a) => i === 0 || (p.y <= a[i - 1].y && p.halfW <= a[i - 1].halfW)), JSON.stringify(r.points));
check('straight ahead: lookahead 0 deg', Math.abs(r.lookaheadRel) < 1, r.lookaheadRel);
check('ribbon starts at the bottom edge', Math.abs(r.points[0].y - o.footY) < 2, r.points[0].y);

// route bends right: 10 m north then 20 m east; camera north
r = gp([at(0, 0), at(10, 0), at(10, 20)], LAT, LON, 0, o);
const xs = r.points.map((p) => p.x);
check('bend to the right: ribbon curves right, not flat across the screen', xs[xs.length - 1] > W / 2 + 30 && r.points.every((p) => p.y >= o.horizonY - 1 && p.y <= o.footY + 1), JSON.stringify(r.points));

// route goes straight east, camera north: nothing is in front, hint says right
r = gp([at(0, 0), at(0, 30)], LAT, LON, 0, o);
check('route entirely to the right: ribbon still starts at the feet and bends to the right edge', r.points.length >= 2 && Math.abs(r.points[0].y - o.footY) < 2 && r.points[r.points.length - 1].x > W / 2 + 150 && r.points[r.points.length - 1].x < W && Math.abs(r.lookaheadRel - 90) < 2, JSON.stringify(r));
r = gp([at(0, 0), at(0, -30)], LAT, LON, 0, o);
check('route entirely to the left: lookahead about -90', Math.abs(r.lookaheadRel + 90) < 2, r.lookaheadRel);
r = gp([at(0, 0), at(-30, 0)], LAT, LON, 0, o);
check('route behind: lookahead about 180, ribbon still drawn and on screen', r.points.length >= 2 && Math.abs(Math.abs(r.lookaheadRel) - 180) < 2 && r.points.every((p) => p.x >= 0 && p.x <= W), JSON.stringify(r));
check('every point of every case is on screen horizontally', [[at(0, 0), at(0, 30)], [at(0, 0), at(-30, 0)], [at(0, 0), at(10, -40)]].every((pl) => gp(pl, LAT, LON, 0, o).points.every((p) => p.x >= 0 && p.x <= W)));

// same east route but the user turns to face east: ribbon appears straight ahead
r = gp([at(0, 0), at(0, 30)], LAT, LON, 90, o);
check('turn to face the route: ribbon centred', r.points.length >= 2 && Math.abs(r.points[r.points.length - 1].x - W / 2) < 3, JSON.stringify(r.points));

// part of the route already walked is not drawn
const line = [0, 5, 10, 15, 20, 25, 30].map((n) => at(n, 0));
r = gp(line, LAT + 15 * MLAT, LON, 0, o);
check('walked part (behind) not drawn; lookahead still ahead', Math.abs(r.lookaheadRel) < 1 && r.points.length >= 2, JSON.stringify(r));

// user is off the line by 4 m to the west, route runs north: ribbon bends toward the line
r = gp([at(0, 0), at(30, 0)], LAT, LON - 4 * MLON, 0, o);
check('standing beside the route: ribbon heads right toward it', r.points[r.points.length - 1].x > W / 2 + 5, JSON.stringify(r.points));

check('no usable route -> nothing to draw', gp([at(0, 0)], LAT, LON, 0, o).points.length < 2);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
