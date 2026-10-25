// Run: node test/e2e-detection.js   (needs: playwright + a local server, see below)
// Drives the real UI in headless Chromium with a fake camera. The COCO-SSD
// CDN script is replaced by a stub that returns window.__preds, so this tests
// the integration (tracker -> hazard speech -> voice commands -> overlay ->
// vibration/spatial audio), not the neural network's accuracy.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const OUT = process.env.OUT_DIR || '/tmp';
const URL = process.env.APP_URL || 'http://localhost:8765/';

let pass = 0, fail = 0;
const check = (n, c, x) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n + (x ? '  -> ' + x : ''))); };

(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox'] });
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 860 }, hasTouch: true, isMobile: true,
    permissions: ['camera', 'microphone', 'geolocation'],
    geolocation: { latitude: 12.9677, longitude: 79.1590, accuracy: 10 },
  });
  await ctx.addInitScript(() => {
    window.__vibes = [];
    navigator.vibrate = (p) => { window.__vibes.push(p); return true; };
  });
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

  // Stand-ins for the CDN libraries (blocked in this sandbox).
  await page.route('**/tensorflow/**/tf.min.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.tf={};' }));
  await page.route('**/coco-ssd/**/coco-ssd.min.js', (r) => r.fulfill({
    contentType: 'text/javascript',
    body: 'window.cocoSsd={load:async()=>({detect:async()=>window.__preds||[]})};',
  }));

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  await page.click('#mic-btn');
  await page.waitForTimeout(2500);

  const started = await page.evaluate(() => !!(hazards && hazards.running && hazards.model));
  check('detector loaded and running after tapping mic', started);

  // record everything the app says
  await page.evaluate(() => {
    window.__spoken = [];
    const orig = voice.speak.bind(voice);
    window.__answers = [];
    voice.speak = (t, o) => {
      const r = orig(t, o);
      if (r) window.__spoken.push(t); // only utterances that passed the cooldown gate
      if (o && /^scene-/.test(o.key || '')) window.__answers.push(t);
      return r;
    };
  });
  const say = async (utterance) => {
    await page.evaluate((u) => { window.__answers.length = 0; voice.isSpeaking = false; voice.wakeWordActive = false; voice._handleTranscript(u); }, utterance);
    await page.waitForTimeout(150);
    return page.evaluate(() => window.__answers[window.__answers.length - 1]);
  };
  const setPreds = (p) => page.evaluate((x) => { window.__preds = x; }, p);
  const { W, H } = await page.evaluate(() => ({ W: els.video.videoWidth, H: els.video.videoHeight }));
  console.log(`     camera frame: ${W}x${H}`);
  const person = (hf, cx) => ({ class: 'person', score: 0.9, bbox: [cx * W - 40, H * 0.15, 80, hf * H] });
  const obj = (cls, hf, cx) => ({ class: cls, score: 0.9, bbox: [cx * W - 30, H * 0.45, 60, hf * H] });

  // --- 1. person on the left, walking closer -------------------------------
  console.log('person approaching from the left');
  for (const hf of [0.22, 0.30, 0.38, 0.46, 0.58]) {
    await setPreds([person(hf, 0.18), obj('chair', 0.2, 0.8), obj('bottle', 0.3, 0.5)]);
    await page.waitForTimeout(330);
  }
  await page.waitForTimeout(400);
  const spoken1 = await page.evaluate(() => window.__spoken.slice());
  console.log('     spoken:', JSON.stringify(spoken1));
  check('spoken: person getting closer from the left', spoken1.some((t) => /Person getting closer from your left/.test(t)));
  const vibes = await page.evaluate(() => window.__vibes.slice());
  check('vibration fired', vibes.length > 0, JSON.stringify(vibes));
  check('critical alert uses the long pattern', vibes.some((v) => Array.isArray(v) && v.length === 5), JSON.stringify(vibes));
  const cue = await page.evaluate(() => voice.lastSpatialCue);
  check('spatial audio panned to the LEFT ear', cue && cue.pan < -0.5, JSON.stringify(cue));
  await page.screenshot({ path: OUT + '/e2e_person_left.png' });

  // --- 2. voice questions, no OpenAI key set --------------------------------
  console.log('voice questions (no API key)');
  const hasKey = await page.evaluate(() => aiAssistant.hasKey());
  check('precondition: no OpenAI key', !hasKey);
  await setPreds([person(0.58, 0.18), person(0.25, 0.82), obj('chair', 0.2, 0.5)]);
  await page.waitForTimeout(700);
  let a = await say('hey nav how many people are near me');
  console.log('     ->', a);
  check('"how many people": answers with 2 people', /2 people/.test(a), a);
  a = await say('hey nav what is in front of me');
  console.log('     ->', a);
  check('"what is in front of me": names a person and a chair', /people|person/.test(a) && /chair/.test(a), a);
  a = await say('hey nav is there any obstacle');
  console.log('     ->', a);
  check('"any obstacle": reports something', /^Yes,/.test(a), a);
  a = await say('hey nav what is ahead');
  console.log('     ->', a);
  check('"what is ahead" answers locally instead of demanding an API key', a && !/OpenAI/.test(a) && /I can see/.test(a), a);

  await setPreds([]);
  await page.waitForTimeout(700);
  a = await say('hey nav is the path clear');
  console.log('     ->', a);
  check('empty view -> path clear', /clear/.test(a), a);
  a = await say('hey nav is anyone nearby');
  check('empty view -> nobody nearby', /don't see anyone/.test(a), a);

  // --- 3. detector off / stale -------------------------------------------------
  console.log('detector stopped');
  await page.evaluate(() => hazards.stop());
  await page.waitForTimeout(3600);
  a = await say('hey nav what do you see');
  console.log('     ->', a);
  check('stale camera data is not reported as fact', /fresh camera reading/.test(a), a);
  await page.evaluate(() => hazards.start(4));

  // --- 4. vibration setting ---------------------------------------------------
  console.log('vibration toggle');
  await page.evaluate(() => { document.getElementById('vibration-toggle').checked = false; document.getElementById('vibration-toggle').dispatchEvent(new Event('change')); window.__vibes.length = 0; });
  await setPreds([person(0.6, 0.5)]);
  await page.waitForTimeout(900);
  const off = await page.evaluate(() => window.__vibes.length);
  check('no vibration when switched off', off === 0, String(off));

  // --- 5. overlay screenshot with a static scene ---------------------------------
  await page.evaluate(() => { document.getElementById('vibration-toggle').checked = true; document.getElementById('vibration-toggle').dispatchEvent(new Event('change')); });
  // The fake camera is 1280x720 landscape but the screen is a portrait crop that shows only the
  // middle ~27% of the frame, so keep boxes inside it (x between ~0.37 and ~0.63).
  for (const hf of [0.22, 0.30, 0.38, 0.46]) {
    await setPreds([person(hf, 0.42), person(0.30, 0.58), obj('chair', 0.28, 0.50), obj('laptop', 0.25, 0.46)]);
    await page.waitForTimeout(330);
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: OUT + '/e2e_overlay.png' });

  console.log('page errors:', errors.length ? '\n' + errors.join('\n') : 'none');
  check('no JavaScript errors', errors.length === 0);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(2); });
