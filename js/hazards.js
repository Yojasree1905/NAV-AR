/**
 * hazards.js
 * -----------------------------------------------------------------------
 * Real-time obstacle warnings from the live camera feed.
 *
 * Object hazards (person, chair, table, and — for outdoor use — vehicles)
 * use TensorFlow.js's pretrained COCO-SSD model, same family as the
 * SSD-Lite MobileNetv2 detector described in build-status.md. COCO has no
 * "door" or "stairs" class, so:
 *   - Door state comes from the venue graph (nodes flagged isDoor) — the
 *     app announces "there should be a door ahead" from map data, which
 *     is far more reliable than trying to vision-classify open/closed
 *     from COCO-SSD. `detectDoorState()` below is a stub: drop in the
 *     project's real geometric door/stairs detector (structure.js) here
 *     if you have it, to confirm state visually instead of just from
 *     the map.
 *   - Steps get a lightweight edge-density heuristic as a low-confidence
 *     fallback. Treat it as a hint, not a replacement for structure.js.
 *
 * Reaction-distance zones and priority weighting reuse the calibration
 * already tuned in the existing app (build-status.md "Key calibration"):
 *   critical ~1.5m, near ~2.5m, mid ~4.5m, far ~8m — approximated here
 * from bounding-box height as a fraction of frame height, since a single
 * phone camera has no depth sensor. NOTE: these thresholds were tuned for
 * indoor furniture at indoor distances — a car at typical road distance
 * fills far less of the frame than a chair at the same "close" distance,
 * so vehicle zone calls are a rougher approximation. Treat "critical" on
 * a vehicle as "it's in frame and looks close," not a precise measurement.
 *
 * TRAFFIC AWARENESS (new): a rolling count of vehicle-class detections
 * per tick, smoothed over a short window, classified into LOW/MEDIUM/HIGH.
 * This is a simple heuristic count of what's visible in the camera's
 * field of view, not a calibrated traffic-engineering metric — it answers
 * "does it look busy right now," which is what the "how's the traffic"
 * voice command needs, not more than that.
 * -----------------------------------------------------------------------
 */

const HAZARD_LABELS = new Set([
  'person', 'chair', 'dining table', 'couch', 'bench',
  'car', 'motorcycle', 'bus', 'bicycle', 'truck',
]);
const LABEL_SPOKEN_AS = {
  'dining table': 'table',
  person: 'person',
  chair: 'chair',
  couch: 'sofa',
  bench: 'bench',
  car: 'car',
  motorcycle: 'motorcycle',
  bus: 'bus',
  bicycle: 'bicycle',
  truck: 'truck',
};
const VEHICLE_CLASSES = new Set(['car', 'motorcycle', 'bus', 'bicycle', 'truck']);

// Everything else COCO-SSD can name that is useful to *describe* when asked
// ("what's in front of me") but not worth interrupting the user for. These
// never trigger spoken warnings on their own; they only appear in the scene
// list (and as boxes once they are close enough to matter).
const SCENE_ONLY_LABELS = new Set([
  'backpack', 'handbag', 'suitcase', 'umbrella', 'bottle', 'cup', 'laptop', 'tv',
  'potted plant', 'bed', 'toilet', 'sink', 'refrigerator', 'book', 'clock', 'vase',
  'dog', 'cat', 'traffic light', 'stop sign', 'fire hydrant',
]);
const SCENE_SPOKEN_AS = {
  tv: 'television', 'potted plant': 'plant', refrigerator: 'fridge', handbag: 'bag',
};

// Bounding-box height / frame height thresholds, mapped to the app's
// existing reaction-distance zones. Tune per-phone during calibration.
const ZONE_THRESHOLDS = [
  { zone: 'critical', minHeightRatio: 0.55 },
  { zone: 'near', minHeightRatio: 0.32 },
  { zone: 'mid', minHeightRatio: 0.16 },
  { zone: 'far', minHeightRatio: 0.0 },
];

// Rough, adjustable thresholds for "how busy does this look" — average
// vehicle count in frame over the last TRAFFIC_WINDOW ticks.
const TRAFFIC_WINDOW = 5;
const TRAFFIC_THRESHOLDS = { low: 2, medium: 5 }; // < low -> LOW, < medium -> MEDIUM, else HIGH

function zoneFor(heightRatio) {
  for (const t of ZONE_THRESHOLDS) {
    if (heightRatio >= t.minHeightRatio) return t.zone;
  }
  return 'far';
}

function lateralGuidance(centerXRatio) {
  // centerXRatio in [0,1]; 0.5 = dead ahead
  if (centerXRatio < 0.4) return 'move slightly right';
  if (centerXRatio > 0.6) return 'move slightly left';
  return 'stop, or step around carefully';
}

/**
 * 'approaching' when the box has grown by >=12% over at least half a second
 * of history, 'receding' for the opposite, otherwise 'steady'. Needs several
 * samples so one noisy box can't flip it.
 */
function trendOf(hist) {
  if (hist.length < 4) return 'steady';
  const first = hist[0];
  const last = hist[hist.length - 1];
  if (last.t - first.t < 500) return 'steady';
  const rel = (last.h - first.h) / Math.max(first.h, 0.01);
  if (rel >= 0.12) return 'approaching';
  if (rel <= -0.12) return 'receding';
  return 'steady';
}

function trafficLevelFor(avgCount) {
  if (avgCount < TRAFFIC_THRESHOLDS.low) return 'LOW';
  if (avgCount < TRAFFIC_THRESHOLDS.medium) return 'MEDIUM';
  return 'HIGH';
}

// Where to look if the <script> tags in index.html (cdnjs) didn't deliver.
const SCRIPT_FALLBACKS = {
  tf: [
    'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js',
    'https://unpkg.com/@tensorflow/tfjs@4.22.0/dist/tf.min.js',
  ],
  cocoSsd: [
    'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js',
    'https://unpkg.com/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js',
  ],
};

function loadScript(src, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    const timer = setTimeout(() => { el.remove(); reject(new Error('timed out')); }, timeoutMs);
    el.src = src;
    el.async = true;
    el.onload = () => { clearTimeout(timer); resolve(); };
    el.onerror = () => { clearTimeout(timer); el.remove(); reject(new Error('blocked or unreachable')); };
    document.head.appendChild(el);
  });
}

/** Makes sure window[name] exists, trying each fallback URL in turn. */
async function ensureGlobal(name, urls) {
  if (typeof window[name] !== 'undefined') return;
  const failures = [];
  for (const url of urls) {
    try {
      await loadScript(url);
      if (typeof window[name] !== 'undefined') return;
      failures.push('loaded but missing ' + name);
    } catch (e) {
      failures.push(new URL(url).host + ' ' + e.message);
    }
  }
  throw new Error(`could not load (${failures.join('; ')})`);
}

class HazardDetector {
  constructor({ videoEl, onHazard, onTrafficUpdate, onDetections }) {
    this.videoEl = videoEl;
    this.onHazard = onHazard; // ({label, zone, guidance, priority}) => void
    this.onTrafficUpdate = onTrafficUpdate; // ({level, counts, totalVehicles}) => void
    this.onDetections = onDetections; // (list, videoWidth, videoHeight) => void -- ALL boxes, for the visual outline overlay
    this.model = null;
    this.backend = null;    // 'webgl' | 'cpu' once started
    this.loadStage = null;  // where load() got to, for error messages
    this.running = false;
    this._vehicleCountHistory = [];
    this._tracks = [];      // per-object tracks, used to tell "getting closer" from "static"
    this._nextTrackId = 0;
    this.latestSnapshot = {
      hazard: null,
      traffic: { level: 'LOW', counts: {}, totalVehicles: 0 },
      scene: [],            // every detection this tick (see scene.js for the record shape)
      timestamp: null,
    };
  }

  /**
   * Loads TensorFlow.js and COCO-SSD. Every stage can fail on a real phone
   * (blocked or slow CDN, no WebGL, model host unreachable), and the old
   * code reported all of them as one opaque failure. Now each stage has a
   * fallback where one exists, and a failure says WHICH stage broke:
   *   scripts : cdnjs tags in index.html first, then jsdelivr, then unpkg
   *   backend : WebGL first, CPU if WebGL isn't usable (slower, still works)
   *   model   : lite model first, then the full model
   * The thrown Error's message is "<stage>: <reason>", shown on screen.
   */
  async load() {
    this.loadStage = 'starting';
    try {
      this.loadStage = 'loading TensorFlow.js';
      await ensureGlobal('tf', SCRIPT_FALLBACKS.tf);
      this.loadStage = 'loading COCO-SSD';
      await ensureGlobal('cocoSsd', SCRIPT_FALLBACKS.cocoSsd);
      this.loadStage = 'starting tensor backend';
      await this._initBackend();
      this.loadStage = 'downloading model';
      try {
        this.model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
      } catch (_) {
        this.model = await cocoSsd.load();
      }
      this.loadStage = 'ready';
    } catch (err) {
      const reason = String((err && err.message) || err || 'unknown error').replace(/\s+/g, ' ').slice(0, 80);
      const wrapped = new Error(`${this.loadStage}: ${reason}`);
      wrapped.stage = this.loadStage;
      throw wrapped;
    }
  }

  async _initBackend() {
    const t = window.tf;
    if (!t || typeof t.setBackend !== 'function') return; // older bundle: it picks its own
    for (const name of ['webgl', 'cpu']) {
      try {
        if (await t.setBackend(name)) {
          if (typeof t.ready === 'function') await t.ready();
          this.backend = name;
          return;
        }
      } catch (_) { /* try the next backend */ }
    }
    throw new Error('no usable TensorFlow backend');
  }

  start(fps = 4) {
    if (this.running) return; // already looping: a second loop would double the work
    this.running = true;
    // The CPU backend is several times slower; asking for 4 fps just queues up work.
    if (this.backend === 'cpu') fps = Math.min(fps, 1.5);
    const interval = 1000 / fps;
    const loop = async () => {
      if (!this.running) return;
      await this._tick();
      setTimeout(loop, interval);
    };
    loop();
  }

  stop() {
    this.running = false;
  }

  async _tick() {
    if (!this.model || this.videoEl.readyState < 2) return;
    const predictions = await this.model.detect(this.videoEl);
    const w = this.videoEl.videoWidth;
    const h = this.videoEl.videoHeight;
    if (!w || !h) return;
    this._process(predictions, w, h, Date.now());
  }

  /**
   * Turns raw COCO-SSD predictions into the hazard to speak, the full scene
   * list, the traffic level and the boxes to draw. Separate from _tick so it
   * can be exercised with scripted predictions and an injected clock.
   */
  _process(predictions, w, h, now) {
    // 1. Normalise every usable prediction into a detection.
    const dets = [];
    for (const p of predictions) {
      const isHazardClass = HAZARD_LABELS.has(p.class);
      if (!isHazardClass && !SCENE_ONLY_LABELS.has(p.class)) continue;
      if (p.score < (isHazardClass ? 0.55 : 0.5)) continue;
      const [x, y, bw, bh] = p.bbox;
      dets.push({
        cls: p.class,
        label: LABEL_SPOKEN_AS[p.class] || SCENE_SPOKEN_AS[p.class] || p.class,
        bbox: p.bbox,
        cx: (x + bw / 2) / w,
        cy: (y + bh / 2) / h,
        h: bh / h,
        isHazardClass,
        isPerson: p.class === 'person',
        isVehicle: VEHICLE_CLASSES.has(p.class),
      });
    }

    // 2. Track across ticks so growth in box height can be read as "closer".
    this._updateTracks(dets, now);

    // 3. Zone, direction, priority, boxes.
    let worst = null; // pick the single highest-priority hazard per tick
    const vehicleCounts = { car: 0, motorcycle: 0, bus: 0, bicycle: 0, truck: 0 };
    for (const p of predictions) {
      if (VEHICLE_CLASSES.has(p.class) && p.score >= 0.5) vehicleCounts[p.class]++;
    }
    const allBoxes = []; // what the AR overlay draws
    const scene = [];    // what voice queries read

    for (const d of dets) {
      d.zone = zoneFor(d.h);
      d.direction = SceneDescriber.directionOf(d.cx);
      d.approaching = d.trend === 'approaching';
      const zoneIdx = ZONE_THRESHOLDS.findIndex((t) => t.zone === d.zone); // lower = more urgent

      scene.push({
        label: d.label, zone: d.zone, direction: d.direction, centerXRatio: d.cx,
        approaching: d.approaching, isPerson: d.isPerson, isVehicle: d.isVehicle,
      });

      // Draw hazard classes always; draw other objects only once they are close enough to matter.
      if (d.isHazardClass || d.zone !== 'far') {
        allBoxes.push({
          label: d.label,
          caption: SceneDescriber.captionFor(d),
          zone: d.zone,
          bbox: d.bbox, // [x, y, width, height] in native video pixel coordinates
          isVehicle: d.isVehicle,
          isPerson: d.isPerson,
          approaching: d.approaching,
        });
      }

      if (!d.isHazardClass || d.zone === 'far') continue; // not worth interrupting the user

      // People and anything closing in rank ahead of equally close static objects.
      const priority = zoneIdx - (d.approaching && (d.isPerson || d.isVehicle) ? 0.5 : 0) - (d.isPerson ? 0.25 : 0);
      const candidate = {
        label: d.label,
        zone: d.zone,
        centerXRatio: d.cx,
        direction: d.direction,
        approaching: d.approaching,
        guidance: d.zone === 'critical' ? lateralGuidance(d.cx) : null,
        priority,
        isPerson: d.isPerson,
        isVehicle: d.isVehicle,
      };
      if (!worst || candidate.priority < worst.priority) worst = candidate;
    }

    // Traffic level: smoothed over a short rolling window so a single
    // frame's miscount (or a car briefly leaving frame) doesn't flip the
    // reported level back and forth.
    const totalVehicles = Object.values(vehicleCounts).reduce((a, b) => a + b, 0);
    this._vehicleCountHistory.push(totalVehicles);
    if (this._vehicleCountHistory.length > TRAFFIC_WINDOW) this._vehicleCountHistory.shift();
    const avgVehicles = this._vehicleCountHistory.reduce((a, b) => a + b, 0) / this._vehicleCountHistory.length;
    const trafficInfo = { level: trafficLevelFor(avgVehicles), counts: vehicleCounts, totalVehicles };

    // Low-confidence "possible steps" hint from edge density (see file header).
    const stepsHint = this._stepsHeuristic();
    if (stepsHint && (!worst || worst.priority > 0)) {
      worst = { label: 'steps', zone: 'near', guidance: null, priority: 1, isHeuristic: true };
    }

    this.latestSnapshot = { hazard: worst, traffic: trafficInfo, scene, timestamp: now };
    if (worst) this.onHazard(worst);
    if (this.onTrafficUpdate) this.onTrafficUpdate(trafficInfo);
    if (this.onDetections) this.onDetections(allBoxes, w, h);
  }

  /**
   * Greedy nearest-centre matching of this tick's detections to existing
   * tracks of the same class. Each track keeps a short history of box
   * heights; a sustained rise means the object is getting closer.
   */
  _updateTracks(dets, now) {
    const MAX_MATCH_DIST = 0.22; // normalised frame units
    const TTL_MS = 1500;
    const WINDOW = 6;
    this._tracks = this._tracks.filter((t) => now - t.lastSeen <= TTL_MS);
    const used = new Set();
    // largest (closest) first, so the big box claims its own track before smaller ones
    const order = dets.slice().sort((a, b) => b.h - a.h);
    for (const d of order) {
      let best = null;
      let bestDist = MAX_MATCH_DIST;
      for (const t of this._tracks) {
        if (used.has(t) || t.cls !== d.cls) continue;
        const dist = Math.hypot(t.cx - d.cx, t.cy - d.cy);
        if (dist < bestDist) { bestDist = dist; best = t; }
      }
      if (!best) {
        best = { id: ++this._nextTrackId, cls: d.cls, hist: [] };
        this._tracks.push(best);
      }
      used.add(best);
      best.cx = d.cx;
      best.cy = d.cy;
      best.lastSeen = now;
      best.hist.push({ t: now, h: d.h });
      if (best.hist.length > WINDOW) best.hist.shift();
      d.trend = trendOf(best.hist);
    }
  }

  /**
   * Rough, low-confidence heuristic: downsample the lower-center third of
   * the frame to grayscale and look for a high density of strong
   * horizontal luminance edges (stair nosings tend to produce repeated
   * horizontal contrast bands). This WILL false-positive on tiled floors
   * and skirting boards — it is a hint to slow down, not a confirmed
   * detection. Swap in the project's real structure.js geometric detector
   * for production accuracy.
   */
  _stepsHeuristic() {
    if (!this._scratch) {
      this._scratch = document.createElement('canvas');
      this._scratch.width = 40;
      this._scratch.height = 30;
    }
    const ctx = this._scratch.getContext('2d');
    const vw = this.videoEl.videoWidth;
    const vh = this.videoEl.videoHeight;
    if (!vw || !vh) return false;
    // sample lower-center third of frame
    ctx.drawImage(this.videoEl, vw * 0.25, vh * 0.55, vw * 0.5, vh * 0.4, 0, 0, 40, 30);
    const { data } = ctx.getImageData(0, 0, 40, 30);
    let edgeRows = 0;
    for (let row = 1; row < 30; row++) {
      let rowDiff = 0;
      for (let col = 0; col < 40; col++) {
        const i1 = (row * 40 + col) * 4;
        const i0 = ((row - 1) * 40 + col) * 4;
        const l1 = data[i1] + data[i1 + 1] + data[i1 + 2];
        const l0 = data[i0] + data[i0 + 1] + data[i0 + 2];
        rowDiff += Math.abs(l1 - l0);
      }
      if (rowDiff / 40 > 90) edgeRows++;
    }
    return edgeRows >= 5; // several distinct horizontal bands
  }

  /** Stub: wire in a real geometric door detector here if available. */
  async detectDoorState(_videoEl) {
    return 'unknown';
  }
}

window.HazardDetector = HazardDetector;
if (typeof module !== 'undefined' && module.exports) module.exports = HazardDetector;
