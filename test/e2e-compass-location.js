// Run: node test/e2e-compass-location.js   (Playwright + the app served at APP_URL)
// Simulates orientation events and GPS fixes in headless Chromium and checks
// the compass pipeline, the GPS-course fallback, landmark projection and the
// location handling. No real sensors, so it proves the logic, not the hardware.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const URL = process.env.APP_URL || 'http://localhost:8765/';

let pass = 0, fail = 0;
const check = (n, c, x) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + x : ''))); };
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

const LAT0 = 12.9677, LON0 = 79.1590;
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

  // ===== 1. basic compass =====
  console.log('1. compass basics');
  await reset();
  await absHeading(90);
  let s = await state();
  check('absolute event alpha=270 -> heading 90', s.h !== null && angDiff(s.h, 90) < 2, s.h);
  await absHeading(10);
  s = await state();
  check('turn to 10 deg', angDiff(s.h, 10) < 2, s.h);
  await absHeading(350);
  s = await state();
  check('turn across north to 350 (no swing through 180)', angDiff(s.h, 350) < 2, s.h);

  await reset();
  await ev('deviceorientation', 12, false, { webkitCompassHeading: 200 });
  for (let i = 0; i < 30; i++) { await ev('deviceorientation', 12, false, { webkitCompassHeading: 200 }); await page.waitForTimeout(12); }
  s = await state();
  check('iOS-style webkitCompassHeading=200 is used', angDiff(s.h, 200) < 2, s.h);

  await reset();
  for (let i = 0; i < 40; i++) { await ev('deviceorientation', 270, true); await page.waitForTimeout(12); }
  s = await state();
  check('Firefox-style deviceorientation with absolute=true -> 90', angDiff(s.h, 90) < 2, s.h);

  // ===== 2. relative vs absolute events (Android Chrome fires both) =====
  console.log('2. absolute and relative events together');
  await reset();
  await absHeading(90, 20);
  const dev = [];
  for (let i = 0; i < 40; i++) {
    await ev('deviceorientationabsolute', 270, true);   // true heading 90
    await ev('deviceorientation', 100, false);          // relative: arbitrary offset, would read 260
    await page.waitForTimeout(12);
    if (i >= 25) dev.push(angDiff((await state()).h, 90));
  }
  check('heading stays on the north-referenced value (max error < 5 deg)', Math.max(...dev) < 5, 'max error ' + Math.max(...dev).toFixed(1));

  await reset();
  for (let i = 0; i < 40; i++) { await ev('deviceorientation', 100, false); await page.waitForTimeout(12); }
  s = await state();
  check('relative-only device still gets a heading (not silently dead)', s.h !== null && s.live);
  const tag = await page.evaluate(() => ar.headingSource);
  check('...but it is labelled as relative, not as a compass', /relative/.test(tag || ''), tag);

  // ===== 3. stale heading =====
  console.log('3. heading goes stale');
  await reset();
  await absHeading(120, 30);
  await page.waitForTimeout(4500); // no further events
  s = await state();
  check('after 4.5 s of silence the heading is no longer reported as live', s.src === null, s.src);
  check('...and it is flagged stale (not "assuming north")', await page.evaluate(() => ar._compassStale === true));
  await page.screenshot({ path: '/tmp/compass_stale.png' });

  // ===== 4. GPS-course fallback while walking =====
  console.log('4. GPS-course fallback');
  await reset();
  await geo(LAT0, LON0, 6); await page.waitForTimeout(700);
  // walking north at ~1.3 m per fix
  for (let i = 1; i <= 14; i++) { await geo(LAT0 + 1.3 * i * M_LAT, LON0, 6); await page.waitForTimeout(650); }
  s = await state();
  check('walking north, no compass: heading ~0 from GPS course', s.src === 'gps-course' && angDiff(s.h, 0) < 15, JSON.stringify(s));
  const la = LAT0 + 1.3 * 14 * M_LAT;
  for (let i = 1; i <= 14; i++) { await geo(la, LON0 + 1.3 * i * M_LON, 6); await page.waitForTimeout(650); }
  s = await state();
  check('then walking east: heading ~90', s.src === 'gps-course' && angDiff(s.h, 90) < 20, JSON.stringify(s));

  await reset();
  await geo(LAT0, LON0, 12); await page.waitForTimeout(700);
  const jitter = [[3, 0], [-3, 2], [2, -3], [-2, 3], [3, 2], [-3, -2], [2, 3], [-3, 0]];
  for (const [n, e] of jitter) { await geo(LAT0 + n * M_LAT, LON0 + e * M_LON, 12); await page.waitForTimeout(650); }
  s = await state();
  check('standing still with +-3 m GPS jitter does NOT invent a heading', s.src !== 'gps-course', JSON.stringify(s));

  // ===== 5. landmark projection =====
  console.log('5. landmark placement');
  await geo(LAT0, LON0, 8); await page.waitForTimeout(800);
  const place = (name, bearingDeg, dist) => page.evaluate(([n, b, d, lat0, lon0]) => {
    const toR = (x) => x * Math.PI / 180;
    const lat = lat0 + (d * Math.cos(toR(b))) / 111320;
    const lon = lon0 + (d * Math.sin(toR(b))) / (111320 * Math.cos(toR(lat0)));
    ar.setNearbyBuildings([{ name: n, lat, lon, id: n }], lat0, lon0);
  }, [name, bearingDeg, dist, LAT0, LON0]);
  const screenX = async (name) => { await page.waitForTimeout(150); return page.evaluate((n) => { const r = ar._hitRects.find((h) => h.id === n); return r ? r.x + r.w / 2 : null; }, name); };
  const W = 412;
  await reset();
  await absHeading(90); await place('East', 90, 40);
  let x = await screenX('East');
  check('building due east, facing east -> centre of screen', x !== null && Math.abs(x - W / 2) < 6, x);
  await absHeading(75); await place('East', 90, 40);
  x = await screenX('East');
  check('facing 75 deg: building is to the RIGHT', x !== null && x > W / 2 + 40, x);
  await absHeading(105); await place('East', 90, 40);
  x = await screenX('East');
  check('facing 105 deg: building is to the LEFT', x !== null && x < W / 2 - 40, x);
  await absHeading(10); await place('East', 90, 40);
  x = await screenX('East');
  check('facing north: east building off screen (not drawn)', x === null, x);
  await absHeading(350); await place('NNE', 10, 40);
  x = await screenX('NNE');
  check('wraparound: facing 350, building at 10 -> right of centre', x !== null && x > W / 2 + 40, x);
  await absHeading(90); await place('Far', 90, 400);
  x = await screenX('Far');
  check('building 400 m away is not shown (60 m limit)', x === null, x);

  // ===== 6. location handling =====
  console.log('6. location handling');
  const calls = await page.evaluate(() => ({ ...window.__geo }));
  await page.evaluate(() => _startGpsNav());
  await page.waitForTimeout(300);
  const calls2 = await page.evaluate(() => ({ ...window.__geo }));
  check('starting navigation does not open a second GPS watch', calls2.watch === calls.watch, `${calls.watch} -> ${calls2.watch}`);
  await page.evaluate(() => _stopGpsNav());

  // arrival with poor accuracy: destination 40 m away, fix accuracy 100 m
  const arrived = await page.evaluate(([lat0, lon0, mlat]) => {
    const destLat = lat0 + 40 * mlat;
    state.phase = 'navigating';
    state.activeRoute = { polyline: [[lat0, lon0], [destLat, lon0]], pointIndex: 0, destLabel: 'Test Dest' };
    gpsNavActive = true;
    _handleGpsUpdate({ lat: lat0, lon: lon0, accuracy: 100, timestamp: Date.now() });
    const r = state.phase;
    gpsNavActive = false; state.phase = 'idle'; state.activeRoute = null;
    return r;
  }, [LAT0, LON0, M_LAT]);
  check('40 m from the destination with a 100 m-accuracy fix is NOT "arrived"', arrived !== 'arrived', arrived);

  // permission denied
  const spoken = [];
  await page.evaluate(() => { window.__sp = []; const o = voice.speak.bind(voice); voice.speak = (t, x) => { const r = o(t, x); if (r) window.__sp.push(t); return r; }; });
  await page.evaluate(() => _handleGpsError());
  const sp = await page.evaluate(() => window.__sp);
  check('GPS error speaks a clear message', sp.some((t) => /can't get a GPS signal/.test(t)), JSON.stringify(sp));

  console.log('page errors:', errors.length ? errors.join(' | ') : 'none');
  check('no JavaScript errors', errors.length === 0);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(2); });
