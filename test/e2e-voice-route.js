// Run: node test/e2e-voice-route.js   (Playwright + the app served at APP_URL)
// Simulates orientation events and GPS fixes in headless Chromium and checks
// the compass pipeline, the GPS-course fallback, landmark projection and the
// location handling. No real sensors, so it proves the logic, not the hardware.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const URL = process.env.APP_URL || 'http://localhost:8765/';

let pass = 0, fail = 0;
const check = (n, c, x) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + x : ''))); };
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

const LAT0 = 12.968139, LON0 = 79.1595688;
const M_LAT = 1 / 111320;                        // degrees per metre, north
const M_LON = 1 / (111320 * Math.cos(LAT0 * Math.PI / 180)); // degrees per metre, east

(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox'] });
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 860 }, hasTouch: true, isMobile: true,
    permissions: ['camera', 'microphone', 'geolocation'],
    geolocation: { latitude: LAT0, longitude: LON0, accuracy: 8 },
  });
  await ctx.addInitScript(() => {
    window.__geo = { watch: 0, clear: 0 };
    const g = navigator.geolocation;
    const w = g.watchPosition.bind(g), c = g.clearWatch.bind(g);
    g.watchPosition = (...a) => { window.__geo.watch++; return w(...a); };
    g.clearWatch = (...a) => { window.__geo.clear++; return c(...a); };
  });
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/tensorflow/**/tf.min.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.tf={};' }));
  await page.route('**/coco-ssd/**/coco-ssd.min.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.cocoSsd={load:async()=>({detect:async()=>[]})};' }));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(2000);
  await page.click('#mic-btn');
  await page.waitForTimeout(2000);

  // ---- helpers run inside the page ----
  const ev = (type, alpha, absolute, extra) => page.evaluate(([t, a, abs, ex]) => {
    const e = new DeviceOrientationEvent(t, { alpha: a, beta: 80, gamma: 0, absolute: abs });
    if (ex && ex.webkitCompassHeading !== undefined) Object.defineProperty(e, 'webkitCompassHeading', { value: ex.webkitCompassHeading });
    window.dispatchEvent(e);
  }, [type, alpha, absolute, extra]);
  const absHeading = async (deg, n = 40) => { for (let i = 0; i < n; i++) { await ev('deviceorientationabsolute', (360 - deg) % 360, true); await page.waitForTimeout(12); } };
  const state = () => page.evaluate(() => ({ h: ar.heading, src: ar.headingSource, live: ar.hasLiveHeading }));
  const reset = () => page.evaluate(() => { ar.heading = null; ar.hasLiveHeading = false; ar.headingSource = null; ar._gpsCourseHeading = null; ar._lastGpsFix = null; ar._courseAnchor = null; ar._headingAt = 0; ar._lastAbsoluteAt = 0; });
  const geo = (lat, lon, accuracy = 8) => ctx.setGeolocation({ latitude: lat, longitude: lon, accuracy });

  const dest = () => page.evaluate(() => ({ route: state.activeRoute && state.activeRoute.destLabel, ar: ar.destLabel, phase: state.phase }));
  await geo(12.96815, 79.15955, 4); await page.waitForTimeout(1500);
  await page.evaluate(() => { voice.synth && voice.synth.cancel(); });
  await page.evaluate(() => voice._handleTranscript('hey nav take me to g block'));
  await page.waitForTimeout(3500);
  let d = await dest();
  check('first command starts a route to G Block', d.route === 'G Block' && d.phase === 'navigating', JSON.stringify(d));
  // the assistant is talking and the user speaks a new destination without the wake word
  await page.evaluate(() => { voice.isSpeaking = true; voice.lastSpokenText = 'Head toward G Block.'; });
  await page.evaluate(() => voice._handleTranscript('take me to h block'));
  await page.waitForTimeout(3500);
  d = await dest();
  check('mid-route, while speaking: "take me to H block" switches the route', d.route === 'H Block' && d.ar === 'H Block', JSON.stringify(d));
  await page.evaluate(() => { voice.isSpeaking = false; });
  await page.evaluate(() => voice._handleTranscript('go to the convenience store'));
  await page.waitForTimeout(3500);
  d = await dest();
  check('mid-route: "go to the convenience store" switches again', d.route === 'Convenience Store', JSON.stringify(d));
  await page.evaluate(() => voice._handleTranscript('change route to jay block'));
  await page.waitForTimeout(3500);
  d = await dest();
  check('mid-route: misheard "jay block" still finds J Block', /^J Block/.test(d.route || ''), JSON.stringify(d));
  check('no page errors', errors.length === 0, errors.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})();
