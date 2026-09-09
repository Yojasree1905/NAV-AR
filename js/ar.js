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
    this.hasLiveHeading = false;

    // GPS & Navigation
    this.currentLat = null;
    this.currentLon = null;
    this.routePolyline = null; // [[lat, lon], ...]
    this.destLabel = '';
    this.distanceRemaining = null;
    this.activeDestination = null; // { name, lat, lon }
    this.nearbyBuildings = [];

    // Hazards & Detections
    this.detectedObjects = [];
    this.detectedVideoSize = { w: 1, h: 1 };
    this.bubbleText = null;
    this.debugInfo = null;

    // Animation phases
    this.dpr = window.devicePixelRatio || 1;
    this.fovH = DEFAULT_FOV_H;
    this._flowPhase = 0;
    this._ringAngle = 0;
    this._rafId = null;

    this._onOrientation = this._onOrientation.bind(this);
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
    window.addEventListener('deviceorientationabsolute', this._onOrientation, true);
    window.addEventListener('deviceorientation', this._onOrientation, true);
    this._raf();
  }

  stop() {
    window.removeEventListener('deviceorientationabsolute', this._onOrientation, true);
    window.removeEventListener('deviceorientation', this._onOrientation, true);
    if (this._rafId) cancelAnimationFrame(this._rafId);
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
    if (typeof e.webkitCompassHeading === 'number') {
      this.heading = e.webkitCompassHeading;
      this.hasLiveHeading = true;
    } else if (e.absolute && e.alpha !== null) {
      this.heading = (360 - e.alpha) % 360;
      this.hasLiveHeading = true;
    } else if (e.alpha !== null) {
      this.heading = (360 - e.alpha) % 360;
      this.hasLiveHeading = true;
    }
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

    // Resolve current compass heading
    let heading = this.heading;
    if (heading === null) {
      heading = 0; // Default to true North if compass not yet active
    }

    // -- Update mini-compass --
    if (window.miniMap) {
      window.miniMap.updateCompass(heading);
    }

    // 1. Perspective Road Pathway Overlay (Images 1 & 2)
    if (this.routePolyline && this.currentLat !== null) {
      this._drawRoadPathway(heading, w, h, topOffset, botOffset);
    }

    // 2. Dotted Circular Landmark Target Reticles (Images 3 & 5)
    this._drawLandmarkReticles(heading, w, h, topOffset, botOffset);

    // 3. Obstacle outline detection boxes
    if (this.detectedObjects?.length) {
      this._drawDetectionOutlines(w, h);
    }

    // 4. Ambient bubble
    if (this.bubbleText) {
      this._drawBubble(w, topOffset);
    }

    ctx.restore();
  }

  // ------------------------------------------------------------------
  // 1. Perspective Road Pathway Ribbon (Images 1 & 2)
  // ------------------------------------------------------------------
  _drawRoadPathway(heading, w, h, topOffset, botOffset) {
    const { ctx } = this;
    const polyline = this.routePolyline;
    if (!polyline || polyline.length < 2) return;

    const halfFov = this.fovH / 2;
    const usableH = h - topOffset - botOffset;
    const horizonY = topOffset + usableH * 0.44; // horizon line
    const footY = h - botOffset - 8;             // starting point right at feet

    // Project points from current position forward
    const projected = [];
    for (let i = 0; i < polyline.length && projected.length < 18; i++) {
      const [pLat, pLon] = polyline[i];
      const dist = _haversine(this.currentLat, this.currentLon, pLat, pLon);
      if (dist > MAX_PATH_DISTANCE) break;

      const bearing = _initialBearing(this.currentLat, this.currentLon, pLat, pLon);
      let rel = bearing - heading;
      rel = ((rel + 540) % 360) - 180;

      // Project onto ground-plane
      const t = Math.min(1, Math.sqrt(dist / MAX_PATH_DISTANCE));
      const py = footY - t * (footY - horizonY);
      const px = w / 2 + (rel / halfFov) * (w / 2);

      // Width of the road pathway tapers into the distance
      const roadHalfW = (w * 0.28) * (1 - t * 0.88) + (w * 0.03) * t;

      projected.push({ x: px, y: py, halfW: roadHalfW, dist });
    }

    if (projected.length < 2) return;

    const anchor = { x: w / 2, y: footY, halfW: w * 0.28 };

    // ---- A. Translucent White Outer Pavement Ribbon (Images 1 & 2) ----
    const leftEdge = [{ x: anchor.x - anchor.halfW, y: anchor.y }];
    const rightEdge = [{ x: anchor.x + anchor.halfW, y: anchor.y }];

    for (const p of projected) {
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

    for (const p of projected) {
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
    const centerPoints = [{ x: anchor.x, y: anchor.y }, ...projected.map(p => ({ x: p.x, y: p.y }))];
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
  _drawLandmarkReticles(heading, w, h, topOffset, botOffset) {
    if (this.currentLat === null || this.currentLon === null) return;
    const halfFov = this.fovH / 2;
    const { ctx } = this;
    const MAX_VISIBLE_DISTANCE = 200; // Show buildings up to 200m away

    // Targets to display: active destination (always while navigating) or closest buildings
    let targets = [];
    if (this.activeDestination && this.activeDestination.lat != null) {
      const dist = _haversine(this.currentLat, this.currentLon, this.activeDestination.lat, this.activeDestination.lon);
      // Always show destination reticle when navigating (up to 200m)
      if (dist <= MAX_VISIBLE_DISTANCE) {
        targets = [{
          name: this.activeDestination.name,
          lat: this.activeDestination.lat,
          lon: this.activeDestination.lon,
          purpose: this.activeDestination.purpose || '',
          dist,
          isDest: true,
        }];
      }
    } else {
      // Explore mode: find buildings within camera FOV (< 200m)
      const inFront = this.nearbyBuildings
        .filter(b => b.lat && b.lon)
        .map(b => {
          const dist = _haversine(this.currentLat, this.currentLon, b.lat, b.lon);
          const bearing = _initialBearing(this.currentLat, this.currentLon, b.lat, b.lon);
          let rel = bearing - heading;
          rel = ((rel + 540) % 360) - 180;
          return { ...b, dist, rel };
        })
        .filter(b => b.dist <= MAX_VISIBLE_DISTANCE && Math.abs(b.rel) <= halfFov * 1.0)
        .sort((a, b) => a.dist - b.dist);

      if (inFront.length) targets = inFront.slice(0, 2);
    }

    for (const target of targets) {
      const dist = target.dist != null ? target.dist : _haversine(this.currentLat, this.currentLon, target.lat, target.lon);
      if (dist > MAX_VISIBLE_DISTANCE) continue;

      const bearing = _initialBearing(this.currentLat, this.currentLon, target.lat, target.lon);
      let rel = bearing - heading;
      rel = ((rel + 540) % 360) - 180;

      // Only draw if within camera FOV
      if (Math.abs(rel) > halfFov * 1.0) continue;

      // Inside Camera View: Draw Circular Dotted Reticle + Overlayed Purpose Box + Arrow
      const screenX = w / 2 + (rel / halfFov) * (w / 2);
      const screenY = topOffset + (h - topOffset - botOffset) * 0.44;
      const ringRadius = Math.max(22, Math.min(38, 38 - (dist / 200) * 12));


      ctx.save();
      ctx.translate(screenX, screenY);

      // ---- 1. Dotted Circular Target Ring on Building Point ----
      ctx.beginPath();
      ctx.arc(0, 0, ringRadius, 0, Math.PI * 2);
      ctx.lineWidth = 2.5;
      ctx.setLineDash([4, 4]); // dotted circle
      ctx.strokeStyle = target.isDest ? '#00e5cc' : 'rgba(255, 255, 255, 0.9)';
      ctx.stroke();
      ctx.setLineDash([]); // reset dash

      // Glowing Center Dot
      ctx.beginPath();
      ctx.arc(0, 0, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = target.isDest ? '#00e5cc' : '#ffffff';
      ctx.shadowColor = target.isDest ? '#00e5cc' : '#ffffff';
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;

      // ---- 2. Downward Arrow Pointing to Reticle Center ----
      const arrowTipY = -ringRadius - 2;
      const arrowBaseY = -ringRadius - 12;
      ctx.beginPath();
      ctx.moveTo(-6, arrowBaseY);
      ctx.lineTo(6, arrowBaseY);
      ctx.lineTo(0, arrowTipY);
      ctx.closePath();
      ctx.fillStyle = target.isDest ? '#00e5cc' : '#ffffff';
      ctx.fill();

      // Connecting stem line
      ctx.beginPath();
      ctx.moveTo(0, arrowBaseY);
      ctx.lineTo(0, -ringRadius - 16);
      ctx.lineWidth = 2;
      ctx.strokeStyle = target.isDest ? '#00e5cc' : '#ffffff';
      ctx.stroke();

      // ---- 3. Small Overlayed Box: Building Name + Purpose ----
      const purpose = target.purpose || '';
      const distText = dist < 1000 ? `${Math.round(dist)} m` : `${(dist / 1000).toFixed(1)} km`;
      const nameText = target.name || 'Building';

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
      const radius = 10;

      // Draw Glassmorphic Card Background
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(cardX, cardY, cardW, cardH, radius);
      } else {
        ctx.rect(cardX, cardY, cardW, cardH);
      }
      ctx.fillStyle = 'rgba(15, 23, 42, 0.90)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = target.isDest ? '#00e5cc' : 'rgba(255, 255, 255, 0.75)';
      ctx.stroke();

      // Row 1: Building Name & Distance
      ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(nameText, cardX + 10, cardY + (purpose ? 16 : cardH / 2));

      ctx.font = 'bold 11px monospace';
      ctx.textAlign = 'right';
      ctx.fillStyle = target.isDest ? '#00e5cc' : '#99f6e4';
      ctx.fillText(distText, cardX + cardW - 10, cardY + (purpose ? 16 : cardH / 2));

      // Row 2: Purpose Pill
      if (purpose) {
        const pillY = cardY + 28;
        const pillH = 17;
        const pillW = cardW - 16;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(cardX + 8, pillY, pillW, pillH, 4);
        } else {
          ctx.rect(cardX + 8, pillY, pillW, pillH);
        }
        ctx.fillStyle = target.isDest ? 'rgba(0, 229, 204, 0.18)' : 'rgba(255, 255, 255, 0.12)';
        ctx.fill();

        ctx.font = '500 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = target.isDest ? '#99f6e4' : '#e2e8f0';

        // Clip text if necessary
        let dispPurp = purpose;
        if (ctx.measureText(dispPurp).width > pillW - 10) {
          while (dispPurp.length > 5 && ctx.measureText(dispPurp + '…').width > pillW - 10) {
            dispPurp = dispPurp.slice(0, -1);
          }
          dispPurp += '…';
        }
        ctx.fillText(dispPurp, cardX + 13, pillY + pillH / 2 + 0.5);
      }

      ctx.restore();
    }
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

      ctx.save();
      ctx.strokeStyle = style.color;
      ctx.lineWidth = style.lineWidth;
      ctx.strokeRect(tl.x, tl.y, boxW, boxH);

      ctx.font = '600 12px system-ui, sans-serif';
      const tw = ctx.measureText(obj.label).width;
      const chipW = tw + 12;
      const chipH = 20;
      const chipY = Math.max(tl.y - chipH, 0);
      ctx.fillStyle = style.color;
      ctx.fillRect(tl.x, chipY, chipW, chipH);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(obj.label, tl.x + 6, chipY + chipH / 2 + 1);
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
