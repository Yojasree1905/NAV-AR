// Run: node test/detection-tests.js
// Exercises hazards.js (_process / tracking) and scene.js with scripted
// COCO-SSD predictions and an injected clock. No browser, camera or model.
global.window = global;
const SceneDescriber = require('../js/scene.js');
global.SceneDescriber = SceneDescriber;
const HazardDetector = require('../js/hazards.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

const W = 640, H = 480;
// person box: height fraction hf, horizontal centre cx (0..1)
const person = (hf, cx, score = 0.9) => ({ class: 'person', score, bbox: [cx * W - 40, H * 0.2, 80, hf * H] });
const obj = (cls, hf, cx, score = 0.9) => ({ class: cls, score, bbox: [cx * W - 30, H * 0.4, 60, hf * H] });

function makeDetector() {
  const seen = { hazards: [], boxes: [] };
  const d = new HazardDetector({
    videoEl: {},
    onHazard: (h) => seen.hazards.push(h),
    onTrafficUpdate: () => {},
    onDetections: (b) => seen.boxes.push(b),
  });
  d._stepsHeuristic = () => false; // needs a real <video>/canvas
  return { d, seen };
}

console.log('zones, direction, people');
{
  const { d, seen } = makeDetector();
  d._process([person(0.6, 0.2)], W, H, 1000);
  const hz = seen.hazards[0];
  check('big person -> critical', hz.zone === 'critical', hz.zone);
  check('person on left -> direction left', hz.direction === 'left', hz.direction);
  check('flagged as person', hz.isPerson === true);
  check('static person is not "approaching"', hz.approaching === false);
  check('scene list has the person', d.latestSnapshot.scene.length === 1 && d.latestSnapshot.scene[0].isPerson);
}

console.log('tracking: approaching vs steady vs receding');
{
  const { d } = makeDetector();
  // box height grows 0.20 -> 0.40 over 1.25 s at 4 fps
  [0.20, 0.25, 0.30, 0.35, 0.40].forEach((hf, i) => d._process([person(hf, 0.5)], W, H, 1000 + i * 250));
  check('growing box -> approaching', d.latestSnapshot.scene[0].approaching === true);
  check('same person keeps one track', d._tracks.length === 1, String(d._tracks.length));

  const s = makeDetector();
  [0.30, 0.31, 0.30, 0.31, 0.30].forEach((hf, i) => s.d._process([person(hf, 0.5)], W, H, 1000 + i * 250));
  check('steady box -> not approaching', s.d.latestSnapshot.scene[0].approaching === false);

  const r = makeDetector();
  [0.40, 0.35, 0.30, 0.25, 0.20].forEach((hf, i) => r.d._process([person(hf, 0.5)], W, H, 1000 + i * 250));
  check('shrinking box -> not approaching', r.d.latestSnapshot.scene[0].approaching === false);

  const q = makeDetector();
  [0.2, 0.26, 0.32].forEach((hf, i) => q.d._process([person(hf, 0.5)], W, H, 1000 + i * 100));
  check('too few / too brief samples -> not approaching', q.d.latestSnapshot.scene[0].approaching === false);
}

console.log('tracking: two people kept separate');
{
  const { d } = makeDetector();
  for (let i = 0; i < 5; i++) {
    d._process([person(0.2 + i * 0.05, 0.15), person(0.30, 0.85)], W, H, 1000 + i * 250);
  }
  const sc = d.latestSnapshot.scene;
  const left = sc.find((x) => x.direction === 'left');
  const right = sc.find((x) => x.direction === 'right');
  check('two tracks', d._tracks.length === 2, String(d._tracks.length));
  check('left person approaching', left && left.approaching === true);
  check('right (steady) person not approaching', right && right.approaching === false);
}

console.log('prioritisation');
{
  const { d, seen } = makeDetector();
  // chair and person both in the near zone; person should win
  d._process([obj('chair', 0.40, 0.5), person(0.40, 0.5)], W, H, 1000);
  check('person outranks chair at same distance', seen.hazards[0].label === 'person', seen.hazards[0].label);

  const b = makeDetector();
  // bottle / laptop are scene-only: never trigger a spoken hazard
  b.d._process([obj('bottle', 0.5, 0.5), obj('laptop', 0.5, 0.5)], W, H, 1000);
  check('scene-only objects never raise a hazard', b.seen.hazards.length === 0);
  check('...but are in the scene list', b.d.latestSnapshot.scene.length === 2);
  check('low-confidence person ignored', (() => { const x = makeDetector(); x.d._process([person(0.6, 0.5, 0.4)], W, H, 1000); return x.d.latestSnapshot.scene.length === 0; })());
}

console.log('boxes for the overlay');
{
  const { d, seen } = makeDetector();
  d._process([person(0.4, 0.5), obj('bottle', 0.05, 0.3)], W, H, 1000);
  const boxes = seen.boxes[0];
  check('person box drawn', boxes.some((b) => b.isPerson));
  check('tiny far bottle not drawn (clutter)', !boxes.some((b) => b.label === 'bottle'));
  check('caption carries distance', /m/.test(boxes[0].caption), boxes[0].caption);
}

console.log('spoken hazard messages');
{
  const M = SceneDescriber.hazardMessage;
  check('critical approaching person from left',
    M({ label: 'person', zone: 'critical', direction: 'left', approaching: true, isPerson: true, guidance: 'move slightly right' })
      === 'Person getting closer from your left. Move slightly right.',
    M({ label: 'person', zone: 'critical', direction: 'left', approaching: true, isPerson: true, guidance: 'move slightly right' }));
  check('near static chair', M({ label: 'chair', zone: 'near', direction: 'right' }) === 'Chair nearby, on your right.');
  check('near approaching person', M({ label: 'person', zone: 'near', direction: 'ahead', approaching: true, isPerson: true }) === 'Person getting closer ahead.');
  check('chair never says "getting closer"', !/closer/.test(M({ label: 'chair', zone: 'near', direction: 'ahead', approaching: true })));
  check('steps heuristic', M({ isHeuristic: true }) === 'Possible steps ahead, slow down.');
}

console.log('voice answers (offline)');
{
  const now = 5000;
  const snap = (scene, extra = {}) => ({ hazard: null, traffic: { level: 'LOW', counts: {}, totalVehicles: 0 }, scene, timestamp: now, ...extra });
  const A = (k, s) => SceneDescriber.answerQuery(k, s, { now: now + 500 });
  const P = (zone, dir, ap = false) => ({ label: 'person', zone, direction: dir, approaching: ap, isPerson: true });
  const C = (zone, dir) => ({ label: 'chair', zone, direction: dir });

  check('no detector -> says so', /isn't running/.test(SceneDescriber.answerQuery('scene', null)));
  check('stale snapshot refused', /fresh camera reading/.test(SceneDescriber.answerQuery('scene', snap([]), { now: now + 10000 })));
  check('empty scene', /don't see any objects/.test(A('scene', snap([]))));
  check('people: none', A('people', snap([C('near', 'ahead')])) === "I don't see anyone nearby.");
  const two = A('people', snap([P('near', 'left', true), P('mid', 'right')]));
  check('people: counts two', /^I can see 2 people/.test(two), two);
  check('people: mentions closing in', /getting closer/.test(two), two);
  check('obstacle: clear path', A('obstacle', snap([C('far', 'ahead'), C('near', 'left')])) === 'Your path looks clear right now.');
  const ob = A('obstacle', snap([C('near', 'ahead')]));
  check('obstacle: reports chair ahead', /^Yes, a chair ahead/.test(ob), ob);
  const sc = A('scene', snap([P('near', 'ahead'), C('mid', 'left'), C('far', 'right')]));
  check('scene: nearest first', sc.indexOf('person') < sc.indexOf('chair'), sc);
  check('traffic: none', /No vehicles/.test(A('traffic', snap([]))));
  check('traffic: count', /Traffic looks high, with 6 vehicles/.test(A('traffic', snap([], { traffic: { level: 'HIGH', counts: {}, totalVehicles: 6 } }))));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
