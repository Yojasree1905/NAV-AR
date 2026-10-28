// Spoken-command routing, barge-in while the assistant talks, and spoken-letter matching.
// Run: node test/voice-command-tests.js
const vm = require('vm'), fs = require('fs'), path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let pass = 0, fail = 0;
const check = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + x)); };

// ---- VoiceIO ----
const w = { console, setTimeout, clearTimeout, __activeUtterances: new Set() };
w.window = w; vm.createContext(w);
vm.runInContext(read('js/voice.js'), w);
function makeVoice() {
  const v = Object.create(w.VoiceIO.prototype);
  const calls = { dest: [], stop: 0, status: 0, cancel: 0, wake: 0, repeat: 0 };
  Object.assign(v, {
    isSpeaking: false, wakeWordActive: false, lastSpokenText: '', listening: true, chimesEnabled: false,
    synth: { cancel() { calls.cancel++; } },
    playChime() {}, _emitState() {}, _clearWakeTimeout() {}, _startWakeTimeout() {}, speak() { return true; },
    onDestinationRequest: (d) => calls.dest.push(d), onStop: () => calls.stop++, onStatusRequest: () => calls.status++,
    onWakeWord: () => calls.wake++, onRepeat: () => calls.repeat++,
  });
  return { v, calls };
}

let { v, calls } = makeVoice();
v._handleTranscript('Hey Nav, take me to H Block');
check('wake word + take me to H Block -> destination "h block"', calls.dest[0] === 'h block', JSON.stringify(calls));

({ v, calls } = makeVoice());
v.isSpeaking = true; v.lastSpokenText = 'Head toward G Block.';
v._handleTranscript('hey nav take me to the convenience store');
check('barge-in: accepted while the assistant is speaking, speech cut off', calls.dest[0] === 'convenience store' && calls.cancel === 1 && v.isSpeaking === false, JSON.stringify(calls));

({ v, calls } = makeVoice());
v.isSpeaking = true; v.lastSpokenText = 'Head toward G Block.';
v._handleTranscript('head toward g block');
check('echo of its own sentence is ignored', calls.dest.length === 0 && calls.cancel === 0);

({ v, calls } = makeVoice());
v.isSpeaking = true;
v._handleTranscript('take me to h block');
check('plain talk while speaking (no wake word, mic not tapped) is ignored', calls.dest.length === 0);

({ v, calls } = makeVoice());
v.isSpeaking = true; v.wakeWordActive = true;
v._handleTranscript('take me to the j block');
check('mic tapped while speaking: command accepted', calls.dest[0] === 'j block', JSON.stringify(calls));

({ v, calls } = makeVoice());
v._processCommand('take me to the bus stop');
check('"take me to the bus stop" is a destination, not "stop"', calls.dest[0] === 'bus stop' && calls.stop === 0, JSON.stringify(calls));

({ v, calls } = makeVoice());
v._processCommand('find me the convenience store');
check('"find me the convenience store" is a destination, not "where am I"', calls.dest[0] === 'convenience store' && calls.status === 0, JSON.stringify(calls));

({ v, calls } = makeVoice());
v._processCommand('find me');
check('"find me" alone is still a location request', calls.status === 1 && calls.dest.length === 0);

({ v, calls } = makeVoice());
v._processCommand('change route to g block');
check('"change route to G block" mid-route', calls.dest[0] === 'g block', JSON.stringify(calls));

({ v, calls } = makeVoice());
v._processCommand('stop navigation');
check('"stop navigation" still stops', calls.stop === 1 && calls.dest.length === 0);

({ v, calls } = makeVoice());
v._processCommand('where am i');
check('"where am i" still a status request', calls.status === 1 && calls.dest.length === 0);

({ v, calls } = makeVoice());
v._processCommand('where is h block');
check('"where is H block" -> destination', calls.dest[0] === 'h block', JSON.stringify(calls));

({ v, calls } = makeVoice());
v.isNavigating = () => true;
v._handleTranscript('take me to h block');
check('on a route: "take me to H block" works without the wake word', calls.dest[0] === 'h block', JSON.stringify(calls));
({ v, calls } = makeVoice());
v.isNavigating = () => true; v.isSpeaking = true; v.lastSpokenText = 'Head toward G Block.';
v._handleTranscript('change route to j block');
check('on a route, while it is speaking: command accepted and speech cut', calls.dest[0] === 'j block' && calls.cancel === 1, JSON.stringify(calls));
({ v, calls } = makeVoice());
v.isNavigating = () => true;
v._handleTranscript('i am going to be late for class');
check('on a route: ordinary chatter is still ignored', calls.dest.length === 0 && calls.stop === 0);
({ v, calls } = makeVoice());
v.isNavigating = () => false;
v._handleTranscript('take me to h block');
check('not on a route: still needs the wake word', calls.dest.length === 0);

// ---- spoken-letter matching ----
const g = { console, window: null }; g.window = g; vm.createContext(g);
vm.runInContext(read('js/venue-graph.js'), g);
const reg = {};
const gpsNode = (id, label, aliases) => ({ id, label, aliases, lat: 1, lon: 1 });
const ctx2 = vm.createContext({ window: Object.assign(g, { __venueHelpers: { gpsNode }, registerVenue: (x) => { reg[x.id] = x; } }), console });
vm.runInContext(read('js/venues/outdoor-hostels.js'), ctx2);
const nodes = reg.outdoor_hostels.nodes;
const resolve = (t) => { const n = g.resolveGpsNode(nodes, t); return n && n.id; };
for (const [say, want] of [
  ['h block', 'hostel_h'], ['age block', 'hostel_h'], ['each block', 'hostel_h'], ['8 block', 'hostel_h'], ['h lock', 'hostel_h'],
  ['g block', 'hostel_g'], ['gee block', 'hostel_g'], ['jee block', 'hostel_g'], ['g black', 'hostel_g'],
  ['j block', 'hostel_j'], ['jay block', 'hostel_j'], ['j lock', 'hostel_j'],
  ['j block main entrance', 'j_main_entrance'], ['convenience store', 'convenience_store'], ['the store', 'convenience_store'], ['convenient store', 'convenience_store'],
  ['hostel gate', 'main_gate'], ['main gate', 'main_gate'],
]) check(`"${say}" -> ${want}`, resolve(say) === want, resolve(say));

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
