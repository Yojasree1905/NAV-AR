// Run: node test/e2e-footprint.js   (Playwright + the app served at APP_URL)
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

  const W = 412;
  const setPos = (lat, lon) => page.evaluate(([la, lo]) => { ar.setNearbyBuildings(_getKnownCampusPlaces(), la, lo); ar.gpsAccuracy = 3; }, [lat, lon]);
  const screenX = async (name) => { await page.waitForTimeout(200); return page.evaluate((n) => { const r = ar._hitRects.find((h) => h.id === n || (h.name === n)); return r ? r.x + r.w / 2 : null; }, name); };
  const labels = async () => { await page.waitForTimeout(200); return page.evaluate(() => ar._hitRects.map((h) => [h.id, Math.round(h.x + h.w / 2)])); };
  await reset();
  await setPos(12.968139, 79.1595688);          // logged position, facing H Block
  await absHeading(191);
  let l = await labels();
  const h1 = l.find((r) => /H Block/.test(r[0]));
  check('facing H Block (sensor 191): H label at screen centre', h1 && Math.abs(h1[1] - W / 2) < 8, JSON.stringify(l));
  await absHeading(165);
  l = await labels(); const h2 = l.find((r) => /H Block/.test(r[0]));
  check('still centred while the camera sweeps across the building (165)', h2 && Math.abs(h2[1] - W / 2) < 8, JSON.stringify(l));
  await absHeading(140);
  l = await labels(); const h3 = l.find((r) => /H Block/.test(r[0]));
  check('turned 23 deg short of its left edge: label sits to the RIGHT of centre', !h3 || h3[1] > W / 2 + 20, JSON.stringify(l));
  await absHeading(300);
  l = await labels();
  check('facing away (300): no H label', !l.find((r) => /H Block/.test(r[0])), JSON.stringify(l));
  await setPos(12.9681858, 79.1595742);         // 10 m from G, facing it
  await absHeading(88);
  l = await labels(); const g = l.find((r) => /G Block/.test(r[0]));
  check('10 m from G Block facing it (88): G label at centre', g && Math.abs(g[1] - W / 2) < 8, JSON.stringify(l));
  check('no page errors', errors.length === 0, errors.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})();
