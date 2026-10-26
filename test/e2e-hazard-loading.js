// Run: node test/e2e-hazard-loading.js   (Playwright + app served at APP_URL)
// Failure-mode tests for the obstacle detector's loading: blocked cdnjs,
// everything blocked, model download failing, no WebGL. The libraries are
// replaced by stubs (the real ones can't be fetched in CI); this checks the
// fallback chain, the on-screen error text and the retry logic.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const APP = process.env.APP_URL || 'http://localhost:8765/';
let pass = 0, fail = 0;
const check = (n, c, x) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + x : ''))); };

const TF = 'window.tf={setBackend:async(b)=>{ if(b==="webgl"&&window.__noWebgl) return false; window.__backend=b; return true; },ready:async()=>{}};';
const COCO = 'window.cocoSsd={load:async()=>{ if(window.__modelFails) throw new Error("Failed to fetch model.json"); return {detect:async()=>[]}; }};';

async function scenario(name, setup, body) {
  console.log(name);
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox'] });
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 412, height: 860 }, permissions: ['camera', 'microphone', 'geolocation'], geolocation: { latitude: 12.9677, longitude: 79.159, accuracy: 8 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const state = { tfUp: true, cocoUp: true, cdnjsUp: false };
  await setup(page, state);
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  // record speech BEFORE tapping start: the load failure is announced during startup
  await page.evaluate(() => { window.__sp = []; const o = voice.speak.bind(voice); voice.speak = (t, x) => { const r = o(t, x); if (r) window.__sp.push(t); return r; }; });
  await page.click('#mic-btn');
  await page.waitForTimeout(2500);
  await body(page, state);
  check('no uncaught JavaScript errors', errors.length === 0, errors.join(' | '));
  await browser.close();
}
const debug = (page) => page.evaluate(() => ar.debugInfo);

const blockScripts = (page, state) => page.route((u) => /cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com/.test(u.hostname), (r) => {
  const u = r.request().url();
  const isCoco = /coco-ssd/.test(u);
  const host = new URL(u).hostname;
  const up = host.includes('cdnjs') ? state.cdnjsUp : host.includes('jsdelivr') ? (isCoco ? state.cocoUp : state.tfUp) : false;
  if (!up) return host.includes('cdnjs') ? r.fulfill({ status: 404, contentType: 'text/javascript', body: '' }) : r.abort();
  return r.fulfill({ contentType: 'text/javascript', body: isCoco ? COCO : TF });
});

(async () => {
  await scenario('A. cdnjs blocked, jsdelivr works -> falls back and loads', blockScripts, async (page) => {
    const s = await page.evaluate(() => ({ model: !!hazards.model, running: hazards.running, backend: hazards.backend }));
    check('model loaded via fallback CDN', s.model, JSON.stringify(s));
    check('detector is running', s.running);
    check('debug line says OK', /Hazard model: OK/.test(await debug(page)), await debug(page));
  });

  await scenario('B. every script host blocked -> clear reason on screen, then recovers',
    async (page, st) => { st.tfUp = false; st.cocoUp = false; await blockScripts(page, st); },
    async (page, st) => {
      const d = await debug(page);
      check('debug line names the failing stage', /FAILED - loading TensorFlow\.js: could not load/.test(d), d);
      check('debug line no longer says "see console"', !/see console/.test(d));
      const sp = await page.evaluate(() => window.__sp);
      check('user is told by voice, and that it will keep trying', sp.some((t) => /could not start/.test(t) && /keep trying/.test(t)), JSON.stringify(sp));
      st.tfUp = true; st.cocoUp = true;                   // network "comes back"
      await page.waitForTimeout(9500);                    // first retry is scheduled after 8 s
      const ok = await page.evaluate(() => ({ model: !!hazards.model, running: hazards.running }));
      check('automatic retry succeeds once the network is back', ok.model && ok.running, JSON.stringify(ok));
      const sp2 = await page.evaluate(() => window.__sp);
      check('user is told obstacle detection now works', sp2.some((t) => /now working/.test(t)), JSON.stringify(sp2));
      check('debug line back to OK', /Hazard model: OK/.test(await debug(page)), await debug(page));
    });

  await scenario('C. scripts load but the model download fails -> stage is "downloading model"',
    async (page, st) => { st.cdnjsUp = true; await blockScripts(page, st); await page.addInitScript(() => { window.__modelFails = true; }); },
    async (page) => {
      const d = await debug(page);
      check('stage named', /FAILED - downloading model: Failed to fetch model\.json/.test(d), d);
    });

  await scenario('D. no WebGL -> CPU backend, slow-mode frame rate',
    async (page, st) => { st.cdnjsUp = true; await blockScripts(page, st); await page.addInitScript(() => { window.__noWebgl = true; }); },
    async (page) => {
      const s = await page.evaluate(() => ({ backend: hazards.backend, model: !!hazards.model }));
      check('falls back to cpu and still loads', s.backend === 'cpu' && s.model, JSON.stringify(s));
      await page.waitForTimeout(800);
      const d = await debug(page);
      check('debug line says slow mode', /slow mode/.test(d), d);
    });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(2); });
