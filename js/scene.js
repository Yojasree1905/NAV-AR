/**
 * scene.js
 * -----------------------------------------------------------------------
 * Turns the detector's structured output (what is in view, how close, on
 * which side, whether it is getting closer) into short spoken sentences.
 * Entirely rule-based and on-device: no network, no API key. This is the
 * "scene understanding" and "smart obstacle prioritisation" layer of the
 * project spec, and it is what lets "what's in front of me" or "how many
 * people are near me" work offline.
 *
 * A detection record (built by hazards.js) looks like:
 *   { label, zone, direction, centerXRatio, approaching, isPerson, isVehicle }
 *   zone: 'critical' | 'near' | 'mid' | 'far'   (approx. reaction distance)
 *   direction: 'left' | 'ahead' | 'right'
 *   approaching: true when the box has been growing over the last ~second
 *
 * LIMIT worth knowing: "approaching" means the object's box is growing in
 * the frame. A single camera cannot tell "the person walked toward me"
 * from "I walked toward the person", so the wording stays neutral
 * ("getting closer"), and only people and vehicles ever get it.
 * -----------------------------------------------------------------------
 */
(function (root) {
  const ZONE_ORDER = ['critical', 'near', 'mid', 'far'];
  const STALE_AFTER_MS = 3000; // a snapshot older than this is not "what I see now"

  const DISTANCE_TEXT = {
    critical: 'very close, under two metres',
    near: 'about two to three metres away',
    mid: 'about four metres away',
    far: 'further away',
  };
  // short form for the on-screen chips (low-vision distance indicators)
  const DISTANCE_CHIP = { critical: '<1.5 m', near: '~2.5 m', mid: '~4.5 m', far: '8 m+' };

  const IRREGULAR_PLURALS = { 'person': 'people', 'bench': 'benches', 'bus': 'buses', 'couch': 'sofas', 'sofa': 'sofas' };

  function directionOf(centerXRatio) {
    if (centerXRatio < 0.38) return 'left';
    if (centerXRatio > 0.62) return 'right';
    return 'ahead';
  }

  /** Stereo pan for the spatial audio cue: -1 = hard left, +1 = hard right. */
  function panFor(direction) {
    if (direction === 'left') return -0.85;
    if (direction === 'right') return 0.85;
    return 0;
  }

  function article(word) {
    return /^[aeiou]/i.test(word) ? 'an' : 'a';
  }

  function plural(label, n) {
    if (n === 1) return `${article(label)} ${label}`;
    const p = IRREGULAR_PLURALS[label] || `${label}s`;
    return `${n} ${p}`;
  }

  function sideText(direction) {
    if (direction === 'left') return 'on your left';
    if (direction === 'right') return 'on your right';
    return 'ahead';
  }

  function fromText(direction) {
    if (direction === 'left') return 'from your left';
    if (direction === 'right') return 'from your right';
    return 'ahead';
  }

  function capitalise(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function movesCloser(d) {
    return !!d.approaching && (d.isPerson || d.isVehicle);
  }

  function zoneRank(z) {
    const i = ZONE_ORDER.indexOf(z);
    return i === -1 ? ZONE_ORDER.length : i;
  }

  /** Short caption drawn on the AR box: "person ↑ · ~2.5 m". */
  function captionFor(d) {
    return `${d.label}${movesCloser(d) ? ' ↑' : ''} · ${DISTANCE_CHIP[d.zone] || ''}`.trim();
  }

  /**
   * The sentence spoken for a single hazard (the one the detector ranks
   * highest this tick). Side + "getting closer" are included so the user
   * knows where to expect it, not just that something exists.
   */
  function hazardMessage(h) {
    if (h.isHeuristic) return 'Possible steps ahead, slow down.';
    const label = h.label;
    const dir = h.direction || 'ahead';
    const closer = movesCloser(h);

    if (h.zone === 'critical') {
      const where = closer ? `getting closer ${fromText(dir)}` : sideText(dir);
      const advice = h.guidance ? `${capitalise(h.guidance)}.` : 'Stop.';
      return `${capitalise(label)} ${where}. ${advice}`;
    }
    if (h.zone === 'near') {
      return closer
        ? `${capitalise(label)} getting closer ${fromText(dir)}.`
        : `${capitalise(label)} nearby, ${sideText(dir)}.`;
    }
    return `${capitalise(label)} in the distance, ${sideText(dir)}.`;
  }

  /** Groups detections by label, nearest first. */
  function _groups(scene) {
    const byLabel = new Map();
    for (const d of scene) {
      if (!byLabel.has(d.label)) byLabel.set(d.label, []);
      byLabel.get(d.label).push(d);
    }
    const groups = [];
    for (const [label, items] of byLabel) {
      items.sort((a, b) => zoneRank(a.zone) - zoneRank(b.zone));
      groups.push({ label, items, nearest: items[0] });
    }
    groups.sort((a, b) => zoneRank(a.nearest.zone) - zoneRank(b.nearest.zone));
    return groups;
  }

  function _groupPhrase(g) {
    const n = g.items.length;
    const d = g.nearest;
    const what = plural(g.label, n);
    const closer = g.items.some(movesCloser);
    const dist = DISTANCE_TEXT[d.zone];
    if (n === 1) {
      return `${what} ${sideText(d.direction)}, ${dist}${closer ? ' and getting closer' : ''}`;
    }
    return `${what}, the nearest ${sideText(d.direction)}, ${dist}${closer ? ' and getting closer' : ''}`;
  }

  /** Spoken summary of everything in view, most urgent first, capped for listening. */
  function describeScene(scene, maxGroups = 3) {
    if (!scene || !scene.length) return 'I don\'t see any objects in view right now.';
    const groups = _groups(scene);
    const shown = groups.slice(0, maxGroups).map(_groupPhrase);
    let text = `I can see ${shown.join('. Also ')}.`;
    if (groups.length > maxGroups) text += ` Plus ${groups.length - maxGroups} other kinds of objects.`;
    return text;
  }

  /**
   * @param {'scene'|'obstacle'|'people'|'traffic'} kind
   * @param {object|null} snapshot  hazards.latestSnapshot
   * @param {{now?: number}} [opts]
   */
  function answerQuery(kind, snapshot, opts = {}) {
    const now = opts.now !== undefined ? opts.now : Date.now();
    if (!snapshot || !snapshot.timestamp) {
      return 'Obstacle detection isn\'t running, so I can\'t see the scene. Check that obstacle warnings are switched on in Settings.';
    }
    if (now - snapshot.timestamp > STALE_AFTER_MS) {
      return 'I haven\'t had a fresh camera reading for a few seconds, so I can\'t answer that reliably.';
    }
    const scene = snapshot.scene || [];

    if (kind === 'people') {
      const people = scene.filter((d) => d.isPerson);
      if (!people.length) return 'I don\'t see anyone nearby.';
      return `I can see ${_groupPhrase(_groups(people)[0])}.`;
    }

    if (kind === 'obstacle') {
      const blocking = scene
        .filter((d) => d.zone !== 'far' && (d.direction === 'ahead' || d.zone === 'critical'))
        .sort((a, b) => zoneRank(a.zone) - zoneRank(b.zone));
      if (!blocking.length) return 'Your path looks clear right now.';
      const g = _groups(blocking)[0];
      return `Yes, ${_groupPhrase(g)}.`;
    }

    if (kind === 'traffic') {
      const t = snapshot.traffic;
      if (!t) return 'I don\'t have a traffic reading yet.';
      const n = t.totalVehicles || 0;
      const level = String(t.level || 'LOW').toLowerCase();
      if (!n) return 'No vehicles in view, so traffic looks light.';
      return `Traffic looks ${level}, with ${n} ${n === 1 ? 'vehicle' : 'vehicles'} in view.`;
    }

    return describeScene(scene);
  }

  const api = { directionOf, panFor, hazardMessage, describeScene, answerQuery, captionFor, DISTANCE_CHIP, STALE_AFTER_MS };
  root.SceneDescriber = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
