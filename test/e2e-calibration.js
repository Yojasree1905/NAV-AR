// Run: node test/e2e-calibration.js  (app served at APP_URL). Checks the settings panel wiring.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const APP = process.env.APP_URL || 'http://localhost:8765/';
let pass = 0, fail = 0;
const check = (n, c, x) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + x : ''))); };
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, hasTouch: true, isMobile: true,
    permissions: ['camera', 'microphone', 'geolocation'], geolocation: { latitude: 12.9680, longitude: 79.1594, accuracy: 8 }, serviceWorkers: 'block' });
  const errors = []; const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/tensorflow/**/tf.min.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.tf={};' }));
  await page.route('**/coco-ssd/**/coco-ssd.min.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.cocoSsd={load:async()=>({detect:async()=>[]})};' }));
  await page.goto(APP, { waitUntil: 'load' }); await page.waitForTimeout(2000);
  await page.click('#mic-btn'); await page.waitForTimeout(3000);
  // feed a deviceorientationabsolute heading of 79 (alpha 281)
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => { const e = new Event('deviceorientationabsolute'); e.alpha = 281; e.beta = 90; e.gamma = 0; e.absolute = true; window.dispatchEvent(e); });
    await page.waitForTimeout(100);
  }
  const opts = await page.evaluate(() => { document.getElementById('cal-landmark').dispatchEvent(new Event('focus')); return [...document.getElementById('cal-landmark').options].map((o) => o.textContent); });
  check('landmark list has G Block and Hostel Gate', opts.includes('G Block') && opts.includes('Hostel Gate'), opts.join(','));
  await page.evaluate(() => { const s = document.getElementById('cal-landmark'); s.value = [...s.options].find((o) => o.textContent === 'G Block').value; });
  await page.evaluate(() => document.getElementById('cal-log').click());
  const st1 = await page.textContent('#cal-status');
  check('log reports a reading', /Logged #1: facing G Block, sensor 79/.test(st1), st1);
  await page.evaluate(() => document.getElementById('cal-align').click());
  const st2 = await page.textContent('#cal-status');
  check('align reports a correction', /Aligned to G Block: sensor 79°.*correction/.test(st2), st2);
  const off = await page.evaluate(() => window.__arOffset ?? (document.querySelector('#overlay') && null));
  const stored = await page.evaluate(() => localStorage.getItem('navassist_compass_offset'));
  check('offset stored', stored !== null && Math.abs(parseFloat(stored)) > 1, stored);
  await page.evaluate(() => document.getElementById('cal-reset').click());
  check('reset clears storage', (await page.evaluate(() => localStorage.getItem('navassist_compass_offset'))) === null);
  check('no page errors', errors.length === 0, errors.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`); await browser.close(); process.exit(fail ? 1 : 0);
})();
