/**
 * gps-nav.js
 * -----------------------------------------------------------------------
 * Outdoor counterpart to the indoor pedometer system. Two distinct
 * jobs, kept in one file because they share the same underlying
 * `navigator.geolocation` API:
 *
 * 1. GpsTracker — live position tracking during active outdoor
 *    navigation. Unlike indoor dead reckoning (which accumulates
 *    estimated steps and can drift or get stuck if the accelerometer
 *    goes quiet — see the README's real-device findings), GPS gives an
 *    absolute position each update, so outdoor progress is self-correcting
 *    by nature: no drift accumulates, and arrival is detected by actual
 *    proximity, not a step count.
 *
 * 2. WaypointCalibrator — the ONLY way outdoor waypoint coordinates ever
 *    get set. This file contains no fallback, no default, and no guessed
 *    coordinate for any real-world location. A waypoint is `null` until
 *    someone physically stands there and captures a reading. See
 *    venue-graph.js's header for why this matters for a mobility aid.
 * -----------------------------------------------------------------------
 */

class GpsTracker {
  constructor() {
    this.watchId = null;
    this.lastFix = null; // { lat, lon, accuracy, heading, speed, timestamp }
    this.onUpdate = null; // (fix) => void
    this.onError = null; // (err) => void
  }

  start({ onUpdate, onError } = {}) {
    this.onUpdate = onUpdate;
    this.onError = onError;
    // Already watching: just refresh the callbacks. Calling watchPosition again
    // overwrote watchId, leaking the first watch and handling every fix twice.
    if (this.watchId !== null) return;
    if (!navigator.geolocation) {
      onError && onError(new Error('Geolocation not supported on this device/browser.'));
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        this.lastFix = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy, // meters, 1 std-dev radius
          heading: pos.coords.heading, // degrees, course-over-ground; null if stationary
          speed: pos.coords.speed, // m/s; null if unavailable
          timestamp: pos.timestamp,
        };
        this.onUpdate && this.onUpdate(this.lastFix);
      },
      (err) => this.onError && this.onError(err),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
    );
  }

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }
}

class WaypointCalibrator {
  constructor() {
    this.captured = {}; // nodeId -> { lat, lon, accuracy, samples }
  }

  /**
   * Averages several GPS readings over a short window at the current spot
   * — a single reading can easily be 10-20m off; averaging a handful
   * taken a second apart meaningfully tightens that. Returns null if
   * geolocation isn't available or every attempt errored.
   */
  async captureHere({ samples = 5, intervalMs = 800, onProgress } = {}) {
    if (!navigator.geolocation) return null;
    const fixes = [];
    for (let i = 0; i < samples; i++) {
      try {
        const pos = await new Promise((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 8000,
            maximumAge: 0,
          })
        );
        fixes.push({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy });
        onProgress && onProgress(i + 1, samples, fixes[fixes.length - 1]);
      } catch (_) {
        // one bad reading shouldn't kill the whole capture; just skip it
      }
      if (i < samples - 1) await new Promise((r) => setTimeout(r, intervalMs));
    }
    if (fixes.length === 0) return null;

    // Weight toward more accurate (lower-accuracy-number) fixes rather than
    // a plain average, so one bad outlier reading doesn't pull the result
    // as much as several tight ones.
    let sumW = 0, sumLat = 0, sumLon = 0;
    for (const f of fixes) {
      const w = 1 / Math.max(f.accuracy, 1);
      sumW += w;
      sumLat += f.lat * w;
      sumLon += f.lon * w;
    }
    const avgAccuracy = fixes.reduce((s, f) => s + f.accuracy, 0) / fixes.length;
    return { lat: sumLat / sumW, lon: sumLon / sumW, accuracy: avgAccuracy, sampleCount: fixes.length };
  }

  record(nodeId, result) {
    this.captured[nodeId] = result;
  }

  /** Writes captured coordinates directly onto the live graph's nodes, so a route can be tried immediately without exporting/reloading first. */
  applyToGraph(graph) {
    for (const [nodeId, fix] of Object.entries(this.captured)) {
      const node = graph.nodes.get(nodeId);
      if (node) {
        node.lat = fix.lat;
        node.lon = fix.lon;
      }
    }
  }

  /**
   * Produces a copy-pasteable JS snippet with the captured coordinates,
   * to commit into the venue file permanently (see js/venues/outdoor-*.js
   * for the target format). This is the ONLY path by which a coordinate
   * becomes permanent — nothing in this app writes to a shared server.
   */
  exportSnippet() {
    const lines = Object.entries(this.captured).map(([nodeId, fix]) =>
      `  ${JSON.stringify(nodeId)}: { lat: ${fix.lat.toFixed(7)}, lon: ${fix.lon.toFixed(7)} }, // accuracy ~${Math.round(fix.accuracy)}m, ${fix.sampleCount} samples`
    );
    return `// Paste into the CALIBRATED_COORDS object in the matching js/venues/outdoor-*.js file:\n{\n${lines.join('\n')}\n}`;
  }

  isCalibrated(graph, nodeId) {
    const node = graph.nodes.get(nodeId);
    return !!node && node.lat !== null && node.lon !== null;
  }
}

window.GpsTracker = GpsTracker;
window.WaypointCalibrator = WaypointCalibrator;
