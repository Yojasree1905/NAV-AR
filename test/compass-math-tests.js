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
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
