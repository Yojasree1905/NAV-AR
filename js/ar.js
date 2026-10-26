/**
 * ar.js — Augmented Reality Road Path & Landmark Reticle System
 * -----------------------------------------------------------------------
 * Modeled after visual AR navigation systems (e.g. Google Live View & ARKit):
 *
 * 1. PERSPECTIVE ROAD PATHWAY (from reference images 1 & 2):
 *    - Translucent white walking corridor painted on the road surface.
 *    - Central teal/cyan lane line (#00e5cc) following road geometry.
 *    - Flowing white arrow chevrons along the corridor directing the user forward.
 *    - Tapers off with true ground-plane perspective towards the horizon.
 *    - Active street / destination label projected directly onto the pathway.
 *
 * 2. CIRCULAR LANDMARK TARGET RETICLES (from reference images 3 & 5):
 *    - Dotted pulsing circular target ring (⭕) centered on landmarks/buildings.
 *    - Clean floating typography above the ring (e.g. "AZ Tower", "Ladies Hostel J").
 *    - Distance tag and purpose pill.
 *
 * 3. OBSTACLE OUTLINES & SAFETY:
 *    - Retains COCO-SSD hazard outlines and safety notices.
 * -----------------------------------------------------------------------
 */

const DEFAULT_FOV_H = 60; // camera horizontal field of view
const MAX_PATH_DISTANCE = 150; // meters ahead to draw road corridor

class ArOverlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    // Orientation
    this.heading = null;
    this.compassOffset = 0;   // degrees added to the sensor heading when placing labels (field calibration)
    // A correction from an earlier session is discarded on purpose: the field test showed the raw
    // sensor within ~6 degrees, and a leftover +25 degree Align skewed every label and arrow.
    try { localStorage.removeItem('navassist_compass_offset'); } catch (_) {}
    this.fieldLog = [];       // readings recorded by the field-test panel
    this.hasLiveHeading = false;
    this.headingSource = null; // 'sensor-api' | 'deviceorientation' | 'gps-course' | null — which method actually delivered a reading, shown in the debug readout
    this.pitch = null; // device tilt (beta), for making the path respond to how the phone is actually held
    this._pitchBaseline = null; // calibrated from the first several readings, since people hold phones at different natural angles
    this._pitchSamples = [];
    this._absOrientationSensor = null;
    this._courseAnchor = null; // { lat, lon, t } — fix the GPS-course bearing is measured from (see updateGpsPosition)
    this.showBuildingLabels = true; // user setting; the active destination is always drawn
    this.gpsAccuracy = null;        // metres, latest fix; labels are suppressed when too uncertain to place
    this._headingAt = 0;       // when the last compass reading was accepted, to detect a sensor that has gone quiet
    this._lastAbsoluteAt = 0;  // when the last NORTH-REFERENCED reading arrived (absolute event / iOS compass / sensor API)
    this._gpsCourseHeading = null;
    this._gpsCourseUpdatedAt = 0;

    // Heading diagnostics — every failure path below used to only
    // console.warn(), which is invisible when someone's debugging from a
    // phone screenshot with no devtools access. This tracks *why* each
    // source isn't delivering, so the on-screen NO SIGNAL line can show
    // the actual reason instead of just the fact that it failed.
    this._diag = {
      orientationEvents: 0,      // total deviceorientation/deviceorientationabsolute events received
      alphaNullEvents: 0,        // of those, how many had no usable heading data at all
      sensorApiStatus: 'not tried', // 'not tried' | 'unsupported' | 'permission denied: <sensor>' | 'error: <name>' | 'active'
    };

    // GPS & Navigation
    this.currentLat = null;
    this.currentLon = null;
    this.routePolyline = null; // [[lat, lon], ...]
    this.externalPathActive = false; // true while a WebXrGroundAr session is drawing the ground path itself — skip our own 2D path draw so they don't both render at once
    this.destLabel = '';
    this.distanceRemaining = null;
    this.activeDestination = null; // { name, lat, lon }
    this.nearbyBuildings = [];

    // Hazards & Detections
    this.detectedObjects = [];
    this.detectedVideoSize = { w: 1, h: 1 };
    this.bubbleText = null;
    this.debugInfo = null;

    // Landmark tap-to-enlarge
    this.selectedBuildingId = null; // which non-destination building (if any) is currently shown at full detail
    this._hitRects = []; // screen rects of the last-drawn landmark boxes, for tap hit-testing

    // Animation phases
    this.dpr = window.devicePixelRatio || 1;
    this.fovH = DEFAULT_FOV_H;
    this._flowPhase = 0;
    this._ringAngle = 0;
    this._rafId = null;

    this._onOrientation = this._onOrientation.bind(this);
    this._onTap = this._onTap.bind(this);
  }

  setDpr(dpr) { this.dpr = dpr; }
  setFov(h) { this.fovH = h || DEFAULT_FOV_H; }

  static async requestPermission() {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        return (await DeviceOrientationEvent.requestPermission()) === 'granted';
      } catch (_) { return false; }
    }
    return true;
  }

  start() {
    // Try the Generic Sensor API's AbsoluteOrientationSensor first — a
    // fundamentally different browser API from the older deviceorientation
    // events, fusing the magnetometer/gyroscope/accelerometer itself
    // rather than relying on the browser to package a single 'compass
    // heading' number. Worth trying as a genuine alternative source on
    // devices where deviceorientation reports no data at all. Support is
    // real but inconsistent across Android browsers/OS versions, so this
    // always falls back to the existing deviceorientation listeners
    // (kept active regardless) if it's unavailable or fails for any
    // reason — never a device's only path to a working compass.
    this._startAbsoluteOrientationSensor();

    window.addEventListener('deviceorientationabsolute', this._onOrientation, true);
    window.addEventListener('deviceorientation', this._onOrientation, true);
    // The canvas itself has pointer-events:none (so taps pass through to
    // the buttons underneath it) — the video element beneath it doesn't,
    // so tap-to-enlarge listens there instead. They share the exact same
    // position/size (both `inset:0; width:100%; height:100%`), so a tap's
    // offsetX/offsetY on the video is already in the canvas's coordinate
    // space, no conversion needed.
    const videoEl = document.getElementById('camera');
    if (videoEl) videoEl.addEventListener('click', this._onTap);
    this._raf();
  }

  /**
   * Attempts to use AbsoluteOrientationSensor as the preferred heading
   * source. Requires HTTPS (already true on GitHub Pages) and, on
   * Chrome, the 'accelerometer', 'gyroscope', and 'magnetometer'
   * Permissions-Policy features to be allowed for the top-level page
   * (true by default unless a site explicitly restricts them, which
   * this one doesn't). Every failure path here is caught and simply
   * leaves the existing deviceorientation listeners as the working
   * fallback — this function is not allowed to leave the app worse off
   * than before if it doesn't work.
   */
  async _startAbsoluteOrientationSensor() {
    if (typeof AbsoluteOrientationSensor === 'undefined') {
      this._diag.sensorApiStatus = 'unsupported';
      return;
    }
    try {
      const names = ['accelerometer', 'gyroscope', 'magnetometer'];
      const results = await Promise.all(
        names.map((name) =>
          navigator.permissions.query({ name }).catch(() => ({ state: 'unknown' }))
        )
      );
      const deniedIdx = results.findIndex((r) => r.state === 'denied');
      if (deniedIdx !== -1) {
        this._diag.sensorApiStatus = `permission denied: ${names[deniedIdx]}`;
        return;
      }

      const sensor = new AbsoluteOrientationSensor({ frequency: 10, referenceFrame: 'screen' });
      sensor.addEventListener('reading', () => {
        const heading = _quaternionToHeadingDeg(sensor.quaternion);
        if (heading !== null) {
          const t = Date.now();
          this._applySmoothedHeading(heading);
          this.hasLiveHeading = true;
          this.headingSource = 'sensor-api';
          this._headingAt = t;
          this._lastAbsoluteAt = t; // AbsoluteOrientationSensor is north-referenced
          this._diag.sensorApiStatus = 'active';
        }
      });
      sensor.addEventListener('error', (e) => {
        const name = e.error?.name || String(e);
        console.warn('AbsoluteOrientationSensor error, falling back to deviceorientation:', name);
        this._diag.sensorApiStatus = `error: ${name}`;
        if (this.headingSource === 'sensor-api') {
          this.headingSource = null; // let _onOrientation's deviceorientation readings take back over
        }
      });
      sensor.start();
      this._absOrientationSensor = sensor;
    } catch (err) {
      const name = err.name || String(err);
      console.warn('AbsoluteOrientationSensor unavailable, using deviceorientation:', name);
      this._diag.sensorApiStatus = `error: ${name}`;
    }
  }

  stop() {
    window.removeEventListener('deviceorientationabsolute', this._onOrientation, true);
    window.removeEventListener('deviceorientation', this._onOrientation, true);
    const videoEl = document.getElementById('camera');
    if (videoEl) videoEl.removeEventListener('click', this._onTap);
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this._absOrientationSensor) {
      try { this._absOrientationSensor.stop(); } catch (_) { /* already stopped */ }
      this._absOrientationSensor = null;
    }
  }

  _onTap(e) {
    this.handleTap(e.offsetX, e.offsetY);
  }

  setRoute(polyline, lat, lon, destLabel, distanceRemaining, destPurpose = '') {
    this.currentLat = lat;
    this.currentLon = lon;
    this.routePolyline = Array.isArray(polyline) && polyline.length > 1 ? polyline : null;
    this.destLabel = destLabel || '';
    this.distanceRemaining = distanceRemaining;
    if (polyline && polyline.length) {
      const target = polyline[polyline.length - 1];
      let purpose = destPurpose;
      if (!purpose && this.nearbyBuildings && this.nearbyBuildings.length) {
        const match = this.nearbyBuildings.find(b => b.name && b.name.toLowerCase() === destLabel.toLowerCase());
        if (match) purpose = match.purpose || '';
      }
      this.activeDestination = { name: destLabel, lat: target[0], lon: target[1], purpose: purpose || '' };
    }
  }

  clearRoute() {
    this.routePolyline = null;
    this.destLabel = '';
    this.distanceRemaining = null;
    this.activeDestination = null;
  }

  /** A calibration/log needs a live GPS fix with known, small error. Returns a reason string, or null when fine. */
  gpsTooWeak(maxM = 15) {
    if (this.gpsAccuracy === null) return 'GPS accuracy is unknown, so the position may be stale. Wait for a fresh GPS fix and try again.';
    if (this.gpsAccuracy > maxM) return `GPS accuracy is ${Math.round(this.gpsAccuracy)} m, too weak to calibrate. Wait until it is under ${maxM} m.`;
    return null;
  }

  /** Sensor heading (no calibration), or null when there is no live reading. */
  rawHeading() {
    const live = this.hasLiveHeading && this.heading !== null && (Date.now() - this._headingAt) <= 3000;
    return live ? this.heading : null;
  }

  /**
   * Field calibration: the user faces a known landmark and taps "align".
   * offset = true bearing to the landmark - what the sensor says.
   * Returns {ok, offset, bearing, raw} or {ok:false, reason}.
   */
  calibrateTo(lat, lon, footprint) {
    const raw = this.rawHeading();
    if (raw === null) return { ok: false, reason: 'No live compass reading yet.' };
    if (this.currentLat === null) return { ok: false, reason: 'No GPS fix yet.' };
    const gpsWhy = this.gpsTooWeak();
    if (gpsWhy) return { ok: false, reason: gpsWhy };
    let bearing = _initialBearing(this.currentLat, this.currentLon, lat, lon);
    // A big building is not a point: facing any part of its outline counts as already aligned,
    // otherwise align to its nearest visible edge.
    const fp = _footprintView(this.currentLat, this.currentLon, footprint);
    if (fp && !fp.inside) {
      const into = (((raw - fp.lo) % 360) + 360) % 360;
      if (into <= fp.width) {
        this.compassOffset = 0;
        return { ok: true, offset: 0, bearing: raw, raw, insideOutline: true };
      }
      const toLo = Math.abs(((fp.lo - raw + 540) % 360) - 180);
      const hiEdge = (fp.lo + fp.width) % 360;
      const toHi = Math.abs(((hiEdge - raw + 540) % 360) - 180);
      bearing = toLo <= toHi ? fp.lo : hiEdge;
    }
    const offset = ((bearing - raw + 540) % 360) - 180;
    this.compassOffset = offset; // this session only
    return { ok: true, offset, bearing, raw };
  }

  resetCalibration() {
    this.compassOffset = 0;
    try { localStorage.removeItem('navassist_compass_offset'); } catch (_) {}
  }

  /**
   * Records one field-test reading while the user faces a named landmark:
   * what the sensor says, where GPS says we are, what the bearing to the
   * landmark should be, and the resulting error. Copy the log out and the
   * whole set can be analysed offline.
   */
  logReading(name, lat, lon) {
    const raw = this.rawHeading();
    if (raw === null || this.currentLat === null) return null;
    if (this.gpsTooWeak()) return null;
    const bearing = _initialBearing(this.currentLat, this.currentLon, lat, lon);
    const rec = {
      t: new Date().toISOString(),
      facing: name,
      sensorHeading: Math.round(raw * 10) / 10,
      source: this.headingSource,
      calibrationOffset: Math.round(this.compassOffset * 10) / 10,
      lat: this.currentLat, lon: this.currentLon, gpsAccuracyM: this.gpsAccuracy,
      expectedBearing: Math.round(bearing * 10) / 10,
      distanceM: Math.round(_haversine(this.currentLat, this.currentLon, lat, lon)),
      errorDeg: Math.round((((bearing - raw + 540) % 360) - 180) * 10) / 10,
    };
    this.fieldLog.push(rec);
    return rec;
  }

  /** Updates only the building list; never moves the user's position. */
  setBuildingList(buildings) {
    this.nearbyBuildings = Array.isArray(buildings) ? buildings : [];
  }

  setNearbyBuildings(buildings, lat, lon) {
    this.nearbyBuildings = Array.isArray(buildings) ? buildings : [];
    this.currentLat = lat;
    this.currentLon = lon;
  }

  setActiveDestination(destName, lat, lon, dist) {
    if (!destName) {
      this.activeDestination = null;
      return;
    }
    this.activeDestination = { name: destName, lat, lon };
    this.destLabel = destName;
    this.distanceRemaining = dist;
  }

  clearActiveDestination() {
    this.clearRoute();
  }

  /**
   * GPS-course heading — the lowest-priority fallback, used only when
   * neither sensor-api nor deviceorientation is delivering anything.
   * Derives "which way you're facing" from the bearing between
   * consecutive real GPS fixes, the same technique Google Maps and
   * similar apps fall back to when a device's compass is unreliable —
   * no magnetometer involved at all, just the Geolocation API, which is
   * already working reliably elsewhere in this app.
   *
   * Real limitation, inherent to the technique, not a bug: this can only
   * ever reflect the direction you're actually MOVING, so it's not
   * available while standing still, and it lags slightly behind true
   * heading right after a turn (needs a new fix far enough past the old
   * one to compute a meaningful bearing). Call on every GPS update;
   * safe to call even when standing still or with noisy fixes — those
   * cases are filtered out internally rather than producing a bad
   * heading.
   */
  updateGpsPosition(lat, lon, accuracy) {
    const now = Date.now();
    this.gpsAccuracy = accuracy == null ? null : accuracy;
    const MIN_MOVEMENT_M = 5;
    const MAX_ACCURACY_M = 25;
    const MAX_ANCHOR_AGE_S = 30;
    // A fix with poor accuracy says nothing reliable about direction.
    if (accuracy != null && accuracy > MAX_ACCURACY_M) return;

    if (!this._courseAnchor) {
      this._courseAnchor = { lat, lon, t: now };
      return;
    }
    // The bearing is measured from an ANCHOR fix, not from the previous
    // fix. Fixes arrive about once a second and a walker covers only ~1.3 m
    // in that time, so comparing consecutive fixes never showed enough
    // movement to trust (this fallback never fired while walking). The
    // anchor only moves once real displacement has built up, and that
    // displacement must beat the reported accuracy, so standing still with
    // a few metres of GPS jitter doesn't invent a direction either.
    const dist = _haversine(this._courseAnchor.lat, this._courseAnchor.lon, lat, lon);
    const ageS = (now - this._courseAnchor.t) / 1000;
    const threshold = Math.max(MIN_MOVEMENT_M, accuracy || 0);
    if (dist >= threshold) {
      if (ageS < MAX_ANCHOR_AGE_S) {
        this._gpsCourseHeading = _initialBearing(this._courseAnchor.lat, this._courseAnchor.lon, lat, lon);
        this._gpsCourseUpdatedAt = now;
      }
      this._courseAnchor = { lat, lon, t: now };
    } else if (ageS >= MAX_ANCHOR_AGE_S) {
      this._courseAnchor = { lat, lon, t: now }; // stood still a long time: measure afresh
    }
  }

  setDetectedObjects(boxes, vw, vh) {
    this.detectedObjects = boxes || [];
    this.detectedVideoSize = { w: vw, h: vh };
  }

  showBubble(text)   { this.bubbleText = text; }
  clearBubble()      { this.bubbleText = null; }
  setDebugInfo(text) { this.debugInfo = text; }
  setTarget() {}
  setPath() {}
  clearTarget() { this.clearRoute(); }

  _onOrientation(e) {
    // If AbsoluteOrientationSensor is actively delivering readings,
    // don't also apply deviceorientation's heading on top of it — two
    // different heading sources updating the same value every frame
    // would fight and jitter. deviceorientation still silently takes
    // back over automatically if the sensor API's error handler clears
    // headingSource (see _startAbsoluteOrientationSensor above).
    this._diag.orientationEvents++;
    const now = Date.now();

    // Android Chrome fires BOTH events. 'deviceorientationabsolute' is
    // referenced to magnetic north; plain 'deviceorientation' there is
    // relative to wherever the phone happened to start, so its alpha is NOT
    // a compass heading. Treating both the same made the heading flip
    // between two unrelated values on every event. Rules now:
    //   - north-referenced: absolute event, e.absolute === true (Firefox),
    //     iOS webkitCompassHeading, or the sensor API
    //   - relative-only readings are used only when nothing north-referenced
    //     has arrived recently, and are labelled as such, so a device with
    //     no magnetometer still gets a (non-north) heading but says so
    const sensorApiFresh = this.headingSource === 'sensor-api' && (now - this._headingAt) < 2000;
    if (!sensorApiFresh) {
      let raw = null;
      let kind = 'deviceorientation';
      if (typeof e.webkitCompassHeading === 'number') {
        raw = e.webkitCompassHeading;
        this._lastAbsoluteAt = now;
      } else if (e.alpha !== null) {
        if (e.type === 'deviceorientationabsolute' || e.absolute === true) {
          raw = (360 - e.alpha) % 360;
          this._lastAbsoluteAt = now;
        } else if (now - this._lastAbsoluteAt > 2000) {
          raw = (360 - e.alpha) % 360;
          kind = 'deviceorientation-relative';
        }
        // else: a relative reading while a north-referenced one is active: ignore it
      } else {
        this._diag.alphaNullEvents++;
      }
      if (raw !== null) {
        this._applySmoothedHeading(raw);
        this.hasLiveHeading = true;
        this.headingSource = kind;
        this._headingAt = now;
      }
    }

    // Pitch (beta): front-back tilt, 0=flat face-up, ~90=held upright.
    // People hold phones at different natural angles, so rather than
    // assuming a fixed "correct" angle, calibrate a baseline from the
    // first ~15 readings (roughly however they're holding it when
    // navigation starts) and respond to DEVIATION from that baseline —
    // tilt further down from wherever they started, the path should look
    // closer/lower; tilt up, it should recede higher.
    if (typeof e.beta === 'number') {
      this.pitch = e.beta;
      if (this._pitchBaseline === null) {
        this._pitchSamples.push(e.beta);
        if (this._pitchSamples.length >= 15) {
          this._pitchBaseline = this._pitchSamples.reduce((a, b) => a + b, 0) / this._pitchSamples.length;
        }
      }
    }
  }

  /** Degrees tilted down from the calibrated baseline (positive = looking more toward the ground), clamped to a sane range. Returns 0 until baseline calibration finishes or no pitch data is available. */
  _pitchDeltaDeg() {
    if (this.pitch === null || this._pitchBaseline === null) return 0;
    const delta = this.pitch - this._pitchBaseline;
    return Math.max(-30, Math.min(30, delta));
  }

  /**
   * Low-pass filter for incoming raw heading readings. deviceorientation
   * fires 30-60 times a second straight from the magnetometer, and that
   * signal is genuinely noisy — with no smoothing, every reading snapped
   * this.heading directly, so a few degrees of sensor jitter translated
   * into visibly darting/twitchy label positions even when the phone was
   * held still, and any real rotation looked far more frantic on screen
   * than the actual physical motion. This exponentially-weighted average
   * settles that out while still tracking real turns responsively.
   *
   * Handles the 0°/360° wraparound explicitly (a naive average of e.g.
   * 359° and 2° would wrongly pull toward 180° instead of 0.5°) by
   * smoothing the shortest signed angular difference rather than the
   * raw values themselves.
   */
  _applySmoothedHeading(rawDeg) {
    if (this.heading === null || Number.isNaN(this.heading)) {
      this.heading = rawDeg;
      return;
    }
    const ALPHA = 0.25; // higher = snappier/less smoothing, lower = smoother/more lag
    let diff = ((rawDeg - this.heading + 540) % 360) - 180; // shortest signed diff, range (-180, 180]
    this.heading = (this.heading + diff * ALPHA + 360) % 360;
  }

  _raf() {
    this._draw();
    this._flowPhase = (this._flowPhase + 0.018) % 1;
    this._ringAngle = (this._ringAngle + 0.02) % (Math.PI * 2);
    this._rafId = requestAnimationFrame(() => this._raf());
  }

  // ------------------------------------------------------------------
  // Main Render Frame
  // ------------------------------------------------------------------
  _draw() {
    const { ctx, canvas } = this;
    const dpr = this.dpr || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const topOffset = (document.getElementById('top-bar')?.offsetHeight || 64) + 10;
    const botOffset = (document.getElementById('voice-hub')?.offsetHeight || 130) + 10;

    // Resolve current compass heading. Falling back to 0 (true north)
    // used to happen silently here whenever the compass had no data at
    // all — meaning the app would quietly assume you're facing true
    // north and compute every building's on-screen position from that
    // wrong assumption, with no visible warning. That's very likely why
    // this looked like "the compass isn't working at all": everything
    // *appeared* misaligned because it was being computed from a fake
    // heading, not because the underlying sensor code was broken. Now
    // this is explicit and visible instead of silent.
    //
    // Priority: sensor-api / deviceorientation (whichever is actually
    // delivering readings — set in _onOrientation and
    // _startAbsoluteOrientationSensor) beat GPS-course, since a true
    // compass reading works standing still and reacts instantly, while
    // GPS-course only updates as you walk. GPS-course only takes over
    // when neither sensor method has ever delivered anything AND a
    // recent, real movement-derived bearing exists (checked for
    // staleness — a bearing from 40 seconds ago while now standing still
    // is more likely to mislead than help).
    let heading = this.heading;
    // A compass that has stopped delivering readings (sensor stalled, page
    // was backgrounded, permission pulled) used to stay "live" forever,
    // freezing every label on the last heading with no warning.
    const HEADING_STALE_MS = 3000;
    const compassStale = this.hasLiveHeading && (Date.now() - this._headingAt) > HEADING_STALE_MS;
    const compassLive = this.hasLiveHeading && !compassStale && heading !== null;
    this._compassStale = compassStale;
    if (!compassLive &&
        this._gpsCourseHeading !== null && Date.now() - this._gpsCourseUpdatedAt < 15000) {
      heading = this._gpsCourseHeading;
      this.heading = heading; // keep in sync — other code (e.g. webxr-ar.js's setCompassHeading feed) reads this.heading directly, and the debug readout below does too
      this.headingSource = 'gps-course';
    } else if (!compassLive) {
      this.headingSource = null; // never keep reporting a dead or since-gone-stale source as live
      if (compassStale && heading !== null) {
        // keep the last known heading, but say plainly it is no longer updating
        this._drawNoCompassNotice(w, topOffset, '⚠ Compass stopped updating');
      } else {
        heading = 0;
        this._drawNoCompassNotice(w, topOffset);
      }
    }

    // Field calibration: the sensor heading stays untouched in this.heading;
    // only label/path placement uses the corrected value.
    if (this.compassOffset) heading = (((heading + this.compassOffset) % 360) + 360) % 360;

    // -- Update mini-compass --
    if (window.miniMap) {
      window.miniMap.updateCompass(heading);
    }

    // 1. Perspective Road Pathway Overlay (Images 1 & 2) — skipped while
    // a WebXR ground-locked session (webxr-ar.js) is drawing the real
    // hit-test-anchored path itself, so the two never draw on top of
    // each other.
    if (this.routePolyline && this.currentLat !== null && !this.externalPathActive) {
      this._drawRoadPathway(heading, w, h, topOffset, botOffset);
    }

    // 2. Dotted Circular Landmark Target Reticles (Images 3 & 5)
    this._drawLandmarkReticles(heading, w, h, topOffset, botOffset);

    // 3. Obstacle outline detection boxes
    if (this.detectedObjects?.length) {
      this._drawDetectionOutlines(w, h);
    }

    // 4. Persistent debug readout (hazard model status, live compass
    // heading) — was being set via setDebugInfo() but the actual draw
    // call for it had been dropped somewhere in an earlier rewrite, so
    // it was silently never visible. Restored, and now always includes
    // live heading so "is the compass working" is directly checkable
    // from a screenshot instead of something to guess at.
    const sourceLabels = { 'sensor-api': ' [sensor-api]', deviceorientation: ' [deviceorientation]', 'deviceorientation-relative': ' [RELATIVE - not north]', 'gps-course': ' [gps-course]' };
    const sourceTag = sourceLabels[this.headingSource] || '';
    // When there's no heading at all, append *why* — events:N is the
    // deviceorientation event count (0 means the browser/OS never sent
    // any, almost always a blocked motion-sensor permission), alpha-null
    // means events arrived but carried no orientation data, and
    // sensor-api: shows the Generic Sensor API's own status. This turns
    // a bare "NO SIGNAL" into something a single screenshot can diagnose.
    const d = this._diag;
    const diagTag = ` | events:${d.orientationEvents}` +
      (d.alphaNullEvents ? ` alpha-null:${d.alphaNullEvents}` : '') +
      ` sensor-api:${d.sensorApiStatus}`;
    const compassLine = this.headingSource
      ? `Compass: ${Math.round(this.heading)}°${sourceTag}${this.compassOffset ? ` cal ${this.compassOffset > 0 ? '+' : ''}${Math.round(this.compassOffset)}°` : ''}`
      : this._compassStale
        ? `Compass: STALE, last ${Math.round(this.heading)}°${diagTag}`
        : `Compass: NO SIGNAL (assuming north)${diagTag}`;
    this._drawDebugInfo(w, h, this.debugInfo ? `${compassLine} | ${this.debugInfo}` : compassLine);

    // 4. Ambient bubble
    if (this.bubbleText) {
      this._drawBubble(w, topOffset);
    }

    ctx.restore();
  }

  // ------------------------------------------------------------------
  // 1. Perspective Road Pathway Ribbon (Images 1 & 2)
  // ------------------------------------------------------------------
  /** Small, unmissable warning drawn near the top of the frame whenever the compass has no live data — replaces the old silent "just assume north" fallback so a misaligned display is explained, not mysterious. */
  _drawNoCompassNotice(w, topOffset, text = '⚠ No compass — assuming north') {
    const { ctx } = this;
    ctx.save();
    ctx.font = '700 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const textW = ctx.measureText(text).width;
    const boxW = textW + 20;
    const boxH = 24;
    // Left-anchored: the compass dial and mini-map sit at top-right, and a
    // centred banner slid underneath them, cutting the text off.
    const boxX = 12;
    const boxY = topOffset;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(boxX, boxY, boxW, boxH, 6);
    else ctx.rect(boxX, boxY, boxW, boxH);
    ctx.fillStyle = 'rgba(180, 60, 40, 0.9)';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(text, boxX + 10, boxY + boxH / 2 + 1);
    ctx.restore();
  }

  /** Persistent bottom-left debug readout (compass heading, hazard model status) — developer/tester-visible, not meant to be pretty, so real-device issues are diagnosable from a screenshot instead of a guess. */
  _drawDebugInfo(w, h, text) {
    // Segments separated by " | " each get their own row (stacked upward from
    // the bottom edge), and a row's font shrinks to fit, so a long diagnostic
    // string is never clipped by the screen edge.
    const { ctx } = this;
    const lines = String(text).split(' | ').filter(Boolean);
    const paddingX = 6;
    const rowH = 16;
    const maxW = w - 12 - paddingX * 2;
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    lines.forEach((line, i) => {
      let size = 11;
      ctx.font = `600 ${size}px monospace`;
      while (size > 8 && ctx.measureText(line).width > maxW) {
        size--;
        ctx.font = `600 ${size}px monospace`;
      }
      const textW = Math.min(ctx.measureText(line).width, maxW);
      const y = h - 8 - (lines.length - i) * rowH;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(6, y, textW + paddingX * 2, rowH - 2);
      ctx.fillStyle = '#0f0';
      ctx.fillText(line, 6 + paddingX, y + (rowH - 2) / 2 + 1, maxW);
    });
    ctx.restore();
  }

  /** Big edge arrow when the route ahead is outside the camera view: which way to turn. */
  _drawTurnHint(rel, w, h, topOffset, botOffset) {
    const { ctx } = this;
    const behind = Math.abs(rel) > 135;
    const right = rel > 0;
    const cy = topOffset + (h - topOffset - botOffset) * 0.30;
    const cx = behind ? w / 2 : right ? w - 44 : 44;
    const text = behind ? 'Turn around' : right ? 'Turn right' : 'Turn left';
    ctx.save();
    ctx.fillStyle = 'rgba(0, 204, 187, 0.92)';
    ctx.beginPath(); ctx.arc(cx, cy, 30, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.translate(cx, cy);
    ctx.rotate(behind ? Math.PI / 2 : right ? 0 : Math.PI);
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-6, -14); ctx.lineTo(-6, -5); ctx.lineTo(-14, -5); ctx.lineTo(-14, 5); ctx.lineTo(-6, 5); ctx.lineTo(-6, 14); ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.font = '800 13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff'; ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 4;
    ctx.fillText(text, cx, cy + 48);
    ctx.restore();
  }

  _drawRoadPathway(heading, w, h, topOffset, botOffset) {
    const { ctx } = this;
    const polyline = this.routePolyline;
    if (!polyline || polyline.length < 2) return;

    const halfFov = this.fovH / 2;
    const usableH = h - topOffset - botOffset;
    // Horizon line responds to device pitch: tilt the phone down from
    // however you're naturally holding it and the horizon rises (more
    // ground visible, matching real perspective); tilt up and it drops.
    // ~3.5px per degree of deviation from the calibrated baseline, capped
    // so it can never push the horizon off-screen or past the foot point.
    const pitchShiftPx = this._pitchDeltaDeg() * 3.5;
    const horizonY = Math.max(topOffset + 20, Math.min(h - botOffset - 40, topOffset + usableH * 0.44 - pitchShiftPx));
    const footY = h - botOffset - 8;             // starting point right at feet

    // Ground-plane perspective: each route point is converted to metres
    // right / forward of the user, then projected like a pinhole camera
    // (x = f * right / forward, y = horizon + f * cameraHeight / forward).
    // The old version mapped bearing straight to screen X, so any route point
    // 60+ degrees to the side landed several screens away and the ribbon
    // lay flat across the picture. Points beside or behind are now clipped
    // at the near plane, and a turn arrow tells the user which way to turn.
    const gp = _groundPath(polyline, this.currentLat, this.currentLon, heading,
      { w, horizonY, footY, fovH: this.fovH, maxDist: MAX_PATH_DISTANCE });
    this._pathHintRel = gp.lookaheadRel;
    if (gp.lookaheadRel !== null && Math.abs(gp.lookaheadRel) > halfFov * 0.8) {
      this._drawTurnHint(gp.lookaheadRel, w, h, topOffset, botOffset);
    }
    const projected = gp.points;
    if (projected.length < 2) return;
    const anchor = projected[0];

    // ---- A. Translucent White Outer Pavement Ribbon (Images 1 & 2) ----
    const leftEdge = [{ x: anchor.x - anchor.halfW, y: anchor.y }];
    const rightEdge = [{ x: anchor.x + anchor.halfW, y: anchor.y }];

    for (const p of projected.slice(1)) {
      leftEdge.push({ x: p.x - p.halfW, y: p.y });
      rightEdge.push({ x: p.x + p.halfW, y: p.y });
    }

    ctx.save();
    ctx.beginPath();
    _traceSmooth(ctx, leftEdge, false);
    _traceSmooth(ctx, [...rightEdge].reverse(), true);
    ctx.closePath();

    // Solid clean white roadway fill with subtle border
    ctx.fillStyle = 'rgba(248, 250, 252, 0.72)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.stroke();

    // ---- B. Vibrant Teal Centerline Strip ----
    const centerLeft = [{ x: anchor.x - anchor.halfW * 0.45, y: anchor.y }];
    const centerRight = [{ x: anchor.x + anchor.halfW * 0.45, y: anchor.y }];

    for (const p of projected.slice(1)) {
      centerLeft.push({ x: p.x - p.halfW * 0.45, y: p.y });
      centerRight.push({ x: p.x + p.halfW * 0.45, y: p.y });
    }

    ctx.beginPath();
    _traceSmooth(ctx, centerLeft, false);
    _traceSmooth(ctx, [...centerRight].reverse(), true);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 204, 187, 0.88)'; // vibrant teal lane from reference image
    ctx.fill();

    // ---- C. Flowing White Arrow Chevrons (> > >) ----
    const centerPoints = projected.map(p => ({ x: p.x, y: p.y }));
    const CHEVRON_COUNT = 6;
    for (let i = 0; i < CHEVRON_COUNT; i++) {
      const p = (i / CHEVRON_COUNT + this._flowPhase) % 1;
      const pt = _pointOnPolyline(centerPoints, p);
      const widthAtPoint = anchor.halfW * 0.42 * (1 - p * 0.78);
      _drawForwardChevron(ctx, pt.x, pt.y, pt.angle, widthAtPoint);
    }

    // ---- D. Street / Destination Label on Road Surface (Image 2) ----
    if (this.destLabel && projected.length > 2) {
      const labelPt = projected[1];
      ctx.save();
      ctx.font = '900 16px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
      ctx.shadowBlur = 4;
      ctx.fillText(this.destLabel, labelPt.x, labelPt.y - 12);
      ctx.restore();
    }

    ctx.restore();
  }

  // ------------------------------------------------------------------
  // 2. Dotted Circular Landmark Target Reticle (Images 3 & 5)
  // ------------------------------------------------------------------
  // 2. Dotted Circular Landmark Reticle & Overlayed Purpose Box (with Arrow)
  // ------------------------------------------------------------------
  /**
   * All real buildings currently in the camera's field of view get a
   * floating label, not just the closest one or two — small by default
   * (name + a dot, similar to how production AR wayfinding apps show
   * secondary points of interest), full detail (name, distance, purpose)
   * only for the active navigation destination or whichever building the
   * user has tapped to inspect. Positions are laid out left-to-right by
   * screen X and staggered vertically wherever two would otherwise land
   * on the same spot — this is what "show every building" needs that a
   * fixed single row didn't: with only 1-2 targets a shared row never
   * collided, but with all of them shown at once, nearby buildings at
   * similar bearings need to be stacked, not just spaced.
   */
  _drawLandmarkReticles(heading, w, h, topOffset, botOffset) {
    // Cleared first, before any early return: when no label is on screen the
    // old rects used to stay, so tapping where a label had been still
    // "enlarged" a building that was no longer visible.
    this._hitRects = [];
    if (this.currentLat === null || this.currentLon === null) return;
    const halfFov = this.fovH / 2;
    // Reduced from 200m after a report that labels were showing for
    // buildings too far away to actually be meaningfully "on camera" —
    // a phone camera can't really resolve a specific building's identity
    // much past this range anyway, and it was cluttering the view.
    // Destination gets a bit more headroom than incidental buildings:
    // you still want to see your actual nav target as you approach, even
    // if it's a little past the point of being clearly recognizable,
    // since that's useful progress information, not just identification.
    const MAX_DEST_DISTANCE = 120;
    const MAX_INCIDENTAL_DISTANCE = 60;

    let destTarget = null;
    if (this.activeDestination && this.activeDestination.lat != null) {
      const dist = _haversine(this.currentLat, this.currentLon, this.activeDestination.lat, this.activeDestination.lon);
      if (dist <= MAX_DEST_DISTANCE) {
        destTarget = {
          id: 'dest', name: this.activeDestination.name, lat: this.activeDestination.lat,
          lon: this.activeDestination.lon, purpose: this.activeDestination.purpose || '', dist, isDest: true,
        };
      }
    }

    // Incidental labels are placed purely from GPS position + compass, so they
    // can't know about walls. Hide them when the user turns them off, or when
    // the GPS error is so large (> 30 m) that "H Block is that way" is a guess.
    const MAX_LABEL_GPS_ERROR_M = 30;
    const showOthers = this.showBuildingLabels &&
      (this.gpsAccuracy === null || this.gpsAccuracy <= MAX_LABEL_GPS_ERROR_M);
    const others = (showOthers ? this.nearbyBuildings : [])
      .filter((b) => b.lat && b.lon && (!destTarget || b.name !== destTarget.name))
      .map((b) => {
        const fp = _footprintView(this.currentLat, this.currentLon, b.footprint);
        // Footprint buildings are labelled by their real name ("J Block"), not the entrance they are routed to.
        return { ...b, name: fp && b.buildingName ? b.buildingName : b.name, id: b.id || b.name, fp,
          dist: fp ? fp.nearestM : _haversine(this.currentLat, this.currentLon, b.lat, b.lon) };
      })
      .filter((b) => b.dist <= MAX_INCIDENTAL_DISTANCE);

    const allTargets = destTarget ? [destTarget, ...others] : others;
    if (!allTargets.length) return;

    const laidOut = allTargets
      .map((target) => {
        const bearing = _initialBearing(this.currentLat, this.currentLon, target.lat, target.lon);
        let rel = bearing - heading;
        rel = ((rel + 540) % 360) - 180;
        // A building with an outline is "ahead" anywhere between its two
        // visible edges, so snap to the camera centre when you face it.
        if (target.fp && !target.fp.inside) {
          const lo = ((target.fp.lo - heading + 540) % 360) - 180;
          const hi = lo + target.fp.width;
          if (lo <= 0 && hi >= 0) {
            rel = 0;
          } else {
            const hiWrapped = ((hi + 540) % 360) - 180;
            rel = Math.abs(lo) <= Math.abs(hiWrapped) ? lo : hiWrapped;
          }
        }
        const screenX = w / 2 + (rel / halfFov) * (w / 2);
        return { target, rel, screenX };
      })
      .filter((t) => Math.abs(t.rel) <= halfFov * 1.0)
      .sort((a, b) => a.screenX - b.screenX);
    if (!laidOut.length) return;

    const baseY = topOffset + (h - topOffset - botOffset) * 0.44;
    let lastRight = -Infinity;
    let cumulativeOffset = 0;
    let lastItemWasExpanded = false;

    for (const item of laidOut) {
      const expanded = item.target.isDest || item.target.id === this.selectedBuildingId;
      const halfWidth = expanded ? 100 : 45; // rough width budget used only for the collision check below
      if (item.screenX - halfWidth < lastRight) {
        // Push by whatever vertical clearance the PREVIOUS item actually
        // needs, not a flat step — an expanded card is much taller than a
        // small tag (arrow + ring + card can span 100px+), so stacking a
        // small tag just one fixed row above it wasn't enough clearance
        // and the two still visually overlapped. Verified this exact
        // failure (tap a building to enlarge it, a neighboring small tag
        // then overlapped the enlarged card) before fixing it.
        cumulativeOffset += lastItemWasExpanded ? 122 : 44;
      } else {
        cumulativeOffset = 0;
      }
      const screenY = baseY - cumulativeOffset;
      lastRight = item.screenX + halfWidth;
      lastItemWasExpanded = expanded;
      this._drawOneLandmark(item.target, item.screenX, screenY, expanded);
    }
  }

  /** Draws one landmark, either as a small floating name tag (default) or the full detail card (destination / tapped). Records its screen rect into this._hitRects for tap-to-enlarge hit-testing. */
  _drawOneLandmark(target, screenX, screenY, expanded) {
    const { ctx } = this;
    const dist = target.dist;
    const distText = dist < 1000 ? `${Math.round(dist)} m` : `${(dist / 1000).toFixed(1)} km`;
    const baseName = target.name || 'Building';
    // Small tags carry the distance so it is obvious a label is for something 40 m away, not in the room.
    const nameText = expanded ? baseName : `${baseName} · ${distText}`;
    const color = target.isDest ? '#00e5cc' : '#ffffff';

    ctx.save();
    ctx.translate(screenX, screenY);

    if (!expanded) {
      ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      const textW = ctx.measureText(nameText).width;
      const tagW = textW + 16;
      const tagH = 22;
      const tagX = -tagW / 2;
      const tagY = -tagH - 14;

      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(tagX, tagY, tagW, tagH, 8);
      else ctx.rect(tagX, tagY, tagW, tagH);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(nameText, 0, tagY + tagH / 2 + 0.5);

      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = 6;
      ctx.fill();
      ctx.shadowBlur = 0;

      this._hitRects.push({ id: target.id, x: screenX + tagX, y: screenY + tagY, w: tagW, h: tagH });
      ctx.restore();
      return;
    }

    const ringRadius = Math.max(22, Math.min(38, 38 - (dist / 200) * 12));

    ctx.beginPath();
    ctx.arc(0, 0, ringRadius, 0, Math.PI * 2);
    ctx.lineWidth = 2.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = target.isDest ? color : 'rgba(255, 255, 255, 0.9)';
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(0, 0, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;

    const arrowTipY = -ringRadius - 2;
    const arrowBaseY = -ringRadius - 12;
    ctx.beginPath();
    ctx.moveTo(-6, arrowBaseY);
    ctx.lineTo(6, arrowBaseY);
    ctx.lineTo(0, arrowTipY);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(0, arrowBaseY);
    ctx.lineTo(0, -ringRadius - 16);
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();

    const purpose = target.purpose || '';
    ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    const nameW = ctx.measureText(nameText).width;
    ctx.font = 'bold 11px monospace';
    const distW = ctx.measureText(distText).width;
    ctx.font = '500 10.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    const purpW = purpose ? ctx.measureText(purpose).width : 0;

    const cardW = Math.max(160, Math.min(270, Math.max(nameW + distW + 36, purpW + 20)));
    const cardH = purpose ? 52 : 36;
    const cardX = -cardW / 2;
    const cardY = -ringRadius - 16 - cardH;

    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(cardX, cardY, cardW, cardH, 10);
    else ctx.rect(cardX, cardY, cardW, cardH);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.90)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = target.isDest ? color : 'rgba(255, 255, 255, 0.75)';
    ctx.stroke();

    ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(nameText, cardX + 10, cardY + (purpose ? 16 : cardH / 2));

    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = target.isDest ? color : '#99f6e4';
    ctx.fillText(distText, cardX + cardW - 10, cardY + (purpose ? 16 : cardH / 2));

    if (purpose) {
      const pillY = cardY + 28;
      const pillH = 17;
      const pillW = cardW - 16;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(cardX + 8, pillY, pillW, pillH, 4);
      else ctx.rect(cardX + 8, pillY, pillW, pillH);
      ctx.fillStyle = target.isDest ? 'rgba(0, 229, 204, 0.18)' : 'rgba(255, 255, 255, 0.12)';
      ctx.fill();

      ctx.font = '500 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = target.isDest ? '#99f6e4' : '#e2e8f0';

      let dispPurp = purpose;
      if (ctx.measureText(dispPurp).width > pillW - 10) {
        while (dispPurp.length > 5 && ctx.measureText(dispPurp + '…').width > pillW - 10) {
          dispPurp = dispPurp.slice(0, -1);
        }
        dispPurp += '…';
      }
      ctx.fillText(dispPurp, cardX + 13, pillY + pillH / 2 + 0.5);
    }

    this._hitRects.push({ id: target.id, x: screenX + cardX, y: screenY + cardY, w: cardW, h: cardH + ringRadius + 20 });
    ctx.restore();
  }

  /**
   * Call with the tap's canvas-local (x, y) — same coordinate space as
   * everything drawn above, no DPR conversion needed since the canvas's
   * CSS size already matches logical pixels (ctx.scale(dpr) only affects
   * the backing store resolution, not this coordinate space). Toggles
   * which building is "expanded" to the full detail card; tapping the
   * same one again (or tapping empty space) collapses it back down.
   */
  handleTap(x, y) {
    if (!this._hitRects) return false;
    for (const r of this._hitRects) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        this.selectedBuildingId = this.selectedBuildingId === r.id ? null : r.id;
        return true;
      }
    }
    this.selectedBuildingId = null;
    return false;
  }

  // ------------------------------------------------------------------
  // Obstacle detection outlines & overlays
  // ------------------------------------------------------------------
  _videoToCanvas(x, y, canvasW, canvasH) {
    const { w: vw, h: vh } = this.detectedVideoSize;
    const scale = Math.max(canvasW / vw, canvasH / vh);
    const displayedW = vw * scale;
    const displayedH = vh * scale;
    const offsetX = (canvasW - displayedW) / 2;
    const offsetY = (canvasH - displayedH) / 2;
    return { x: x * scale + offsetX, y: y * scale + offsetY };
  }

  _drawDetectionOutlines(w, h) {
    const { ctx } = this;
    const ZONE_STYLE = {
      critical: { color: 'rgba(239, 68, 68, 0.95)', lineWidth: 3 },
      near:     { color: 'rgba(245, 158, 11, 0.90)', lineWidth: 2.5 },
      mid:      { color: 'rgba(16, 185, 129, 0.80)', lineWidth: 2 },
      far:      { color: 'rgba(148, 163, 184, 0.60)', lineWidth: 1.5 },
    };

    for (const obj of this.detectedObjects) {
      const [bx, by, bw, bh] = obj.bbox;
      const tl = this._videoToCanvas(bx, by, w, h);
      const br = this._videoToCanvas(bx + bw, by + bh, w, h);
      const boxW = br.x - tl.x;
      const boxH = br.y - tl.y;
      const style = ZONE_STYLE[obj.zone] || ZONE_STYLE.far;
      const text = obj.caption || obj.label;

      ctx.save();
      ctx.strokeStyle = style.color;
      ctx.lineWidth = style.lineWidth + (obj.isPerson ? 1.5 : 0) + (obj.approaching ? 1 : 0);
      ctx.strokeRect(tl.x, tl.y, boxW, boxH);

      ctx.font = '600 12px system-ui, sans-serif';
      const tw = ctx.measureText(text).width;
      const chipW = tw + 12;
      const chipH = 20;
      const chipY = Math.max(tl.y - chipH, 0);
      ctx.fillStyle = style.color;
      ctx.fillRect(tl.x, chipY, chipW, chipH);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, tl.x + 6, chipY + chipH / 2 + 1);
      ctx.restore();
    }
  }

  _drawBubble(w, topOffset) {
    const { ctx } = this;
    ctx.font = '600 14px system-ui, sans-serif';
    const paddingX = 16;
    const textWidth = ctx.measureText(this.bubbleText).width;
    const bubbleW = Math.min(textWidth + paddingX * 2, w - 32);
    const bubbleH = 32;
    const bx = (w - bubbleW) / 2;
    const by = topOffset;

    ctx.save();
    _roundRect(ctx, bx, by, bubbleW, bubbleH, 16);
    ctx.fillStyle = 'rgba(37, 99, 235, 0.88)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.bubbleText, w / 2, by + bubbleH / 2 + 1);
    ctx.restore();
  }
}

// ------------------------------------------------------------------
// Geometry Helpers
// ------------------------------------------------------------------

/**
 * Converts an AbsoluteOrientationSensor quaternion [x, y, z, w] into the
 * compass heading (0 = north, clockwise) of the direction the BACK CAMERA
 * faces, which is what the AR labels are placed against.
 *
 * The earlier version took the yaw of the device's X axis (its right edge),
 * which is 90 degrees off from where the camera points: it read 90 with the
 * phone facing north. Now: rotate the camera axis (device -Z) into the world
 * frame (x = east, y = north, z = up). When the phone is held upright that
 * vector is nearly horizontal and gives the heading directly. When the phone
 * is tilted flat (camera pointing at the ground or sky) it is almost
 * vertical and meaningless, so use the top-of-phone axis (device +Y) instead.
 * Returns null for a malformed reading rather than a wrong number.
 */
function _quaternionToHeadingDeg(q) {
  if (!q || q.length < 4) return null;
  const [x, y, z, w] = q;
  if (![x, y, z, w].every(Number.isFinite)) return null;
  // camera axis (-Z column) in world coordinates
  const camE = -2 * (x * z + w * y);
  const camN = -2 * (y * z - w * x);
  // top-of-phone axis (+Y column)
  const topE = 2 * (x * y - w * z);
  const topN = 1 - 2 * (x * x + z * z);
  const camHoriz = Math.hypot(camE, camN);
  const [e, n] = camHoriz > 0.5 ? [camE, camN] : [topE, topN];
  const deg = (Math.atan2(e, n) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/**
 * Where a building outline appears from (lat, lon): the compass bearing of its
 * left edge, its angular width, and the distance to its nearest corner.
 * Returns null without an outline, and {inside:true} when the user is within
 * it or it is wider than 180 degrees (then the point target is used instead).
 */
function _footprintView(lat, lon, pts) {
  if (!Array.isArray(pts) || pts.length < 3 || lat === null) return null;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [yi, xi] = pts[i], [yj, xj] = pts[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  let nearestM = Infinity;
  for (const [a, b] of pts) nearestM = Math.min(nearestM, _haversine(lat, lon, a, b));
  if (inside) return { inside: true, nearestM: 0 };
  const b0 = _initialBearing(lat, lon, pts[0][0], pts[0][1]);
  let min = 0, max = 0;
  for (const [a, b] of pts) {
    const rel = ((_initialBearing(lat, lon, a, b) - b0 + 540) % 360) - 180;
    if (rel < min) min = rel;
    if (rel > max) max = rel;
  }
  if (max - min > 180) return { inside: true, nearestM };
  return { inside: false, lo: (((b0 + min) % 360) + 360) % 360, width: max - min, nearestM };
}

/**
 * Projects the upcoming part of a route onto the ground in front of the
 * camera. Returns {points:[{x,y,halfW,dist}], lookaheadRel} where lookaheadRel
 * is the bearing, relative to where the camera points, of the route about 8 m
 * ahead (null with no route). Pure function, so it is unit-tested.
 */
function _groundPath(polyline, lat, lon, heading, o) {
  const camH = o.camH || 1.4, widthM = o.halfWidthM || 0.6, maxDist = o.maxDist || 60;
  const f = (o.w / 2) / Math.tan((o.fovH / 2) * Math.PI / 180);
  const near = Math.max(0.8, (f * camH) / Math.max(20, o.footY - o.horizonY)); // forward distance that lands on the bottom edge
  const cosLat = Math.cos((lat * Math.PI) / 180), hr = (heading * Math.PI) / 180;
  const local = (pLat, pLon) => {
    const n = (pLat - lat) * 111320, e = (pLon - lon) * 111320 * cosLat;
    return { right: e * Math.cos(hr) - n * Math.sin(hr), fwd: e * Math.sin(hr) + n * Math.cos(hr) };
  };
  const pts = polyline.map(([a, b]) => local(a, b));
  // Start from the route vertex nearest the user so the part already walked is not drawn.
  let i0 = 0, best = Infinity;
  pts.forEach((q, i) => { const d = Math.hypot(q.right, q.fwd); if (d < best) { best = d; i0 = i; } });
  const path = [{ right: 0, fwd: 0, dist: 0 }];
  let acc = 0;
  for (let i = i0; i < pts.length; i++) {
    const prev = path[path.length - 1];
    acc += Math.hypot(pts[i].right - prev.right, pts[i].fwd - prev.fwd);
    path.push({ right: pts[i].right, fwd: pts[i].fwd, dist: acc });
    if (acc > maxDist) break;
  }
  // lookahead direction
  let lookaheadRel = null;
  if (path.length > 1) {
    let tgt = path[path.length - 1];
    for (const q of path) if (q.dist >= 8) { tgt = q; break; }
    lookaheadRel = (Math.atan2(tgt.right, tgt.fwd) * 180) / Math.PI;
  }
  // Densify so the curve stays smooth after the non-linear mapping, drop near-duplicates.
  const dense = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const A = dense[dense.length - 1], B = path[i];
    const len = Math.hypot(B.right - A.right, B.fwd - A.fwd);
    if (len < 0.3) continue;
    const steps = Math.max(1, Math.ceil(len / 2));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      dense.push({ right: A.right + t * (B.right - A.right), fwd: A.fwd + t * (B.fwd - A.fwd), dist: A.dist + t * (B.dist - A.dist) });
    }
  }
  // Perspective inside the camera view; beyond it the ribbon is pinned to the
  // screen edge (at the right depth), so it always starts at the feet and
  // visibly bends toward the route instead of vanishing or lying flat.
  const maxRel = ((o.fovH / 2) * 0.9 * Math.PI) / 180;
  const out = dense.map((q) => {
    const d = Math.hypot(q.right, q.fwd);
    if (d < 0.05) return { x: o.w / 2, y: o.footY, halfW: Math.min(o.w * 0.34, (f * widthM) / near), dist: q.dist };
    const rel = Math.atan2(q.right, q.fwd);
    const c = Math.max(-maxRel, Math.min(maxRel, rel));
    const dEff = Math.max(d * Math.cos(c), near);
    return { x: o.w / 2 + f * Math.tan(c), y: Math.min(o.footY, o.horizonY + (f * camH) / dEff), halfW: Math.min(o.w * 0.34, (f * widthM) / dEff), dist: q.dist };
  });
  return { points: out, lookaheadRel };
}

function _haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _initialBearing(lat1, lon1, lat2, lon2) {
  const toR = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toR(lon2 - lon1)) * Math.cos(toR(lat2));
  const x = Math.cos(toR(lat1)) * Math.sin(toR(lat2))
    - Math.sin(toR(lat1)) * Math.cos(toR(lat2)) * Math.cos(toR(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function _traceSmooth(ctx, points, continuePath) {
  if (!points.length) return;
  if (continuePath) ctx.lineTo(points[0].x, points[0].y);
  else ctx.moveTo(points[0].x, points[0].y);
  if (points.length < 2) return;
  if (points.length === 2) { ctx.lineTo(points[1].x, points[1].y); return; }
  for (let i = 1; i < points.length - 1; i++) {
    const mx = (points[i].x + points[i + 1].x) / 2;
    const my = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
  }
  ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
}

function _pointOnPolyline(points, p) {
  const n = points.length;
  if (n === 1) return { x: points[0].x, y: points[0].y, angle: 0 };
  const s = Math.max(0, Math.min(1, p)) * (n - 1);
  const i0 = Math.min(Math.floor(s), n - 2);
  const i1 = i0 + 1;
  const t  = s - i0;
  return {
    x: points[i0].x + (points[i1].x - points[i0].x) * t,
    y: points[i0].y + (points[i1].y - points[i0].y) * t,
    angle: Math.atan2(points[i1].x - points[i0].x, -(points[i1].y - points[i0].y)),
  };
}

function _drawForwardChevron(ctx, x, y, angle, width) {
  const h = width * 0.7;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, -h);
  ctx.lineTo(width / 2, h * 0.5);
  ctx.lineTo(width * 0.25, h * 0.5);
  ctx.lineTo(0, -h * 0.1);
  ctx.lineTo(-width * 0.25, h * 0.5);
  ctx.lineTo(-width / 2, h * 0.5);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();
}

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

window.ArOverlay = ArOverlay;

ArOverlay.quaternionToHeadingDeg = _quaternionToHeadingDeg; // exposed for tests

ArOverlay.footprintView = _footprintView; // exposed for tests
ArOverlay.groundPath = _groundPath;
