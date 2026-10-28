/**
 * venue-graph.js  (stripped — math utilities only)
 * -----------------------------------------------------------------------
 * The Dijkstra graph engine and hand-authored venue nodes/edges have been
 * removed. Routing is now done by route-provider.js (real walking routes
 * from OSRM / ORS / Google Maps), and destination discovery is handled
 * by map-discovery.js (Overpass API / Nominatim).
 *
 * What remains here:
 *   - Haversine distance + initial bearing math (used by ar.js, gps-nav.js,
 *     app.js for all GPS calculations)
 *   - registerVenue() and window.VENUES registry (still used by the outdoor
 *     hostel venue to register its named GPS anchor points)
 *   - gpsNode() / gpsEdge() helpers (used by outdoor-hostels.js)
 * -----------------------------------------------------------------------
 */

const EARTH_RADIUS_M = 6371000;
function toRad(deg) { return (deg * Math.PI) / 180; }
function toDeg(rad) { return (rad * 180) / Math.PI; }

/** Great-circle distance in meters. Verified against London–Paris (~344 km)
 *  and cardinal-direction test cases. */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial compass bearing (degrees, 0 = north, clockwise) from point 1 to point 2. */
function initialBearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2))
    - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** GPS waypoint node — coordinates start uncalibrated (null) on purpose.
 *  Used by outdoor-hostels.js to register known named anchor points. */
function gpsNode(id, label, aliases, isDoor, purpose) {
  return { id, label, aliases: aliases || [], lat: null, lon: null, isDoor: !!isDoor, isGps: true, purpose: purpose || '' };
}

function gpsEdge(a, b) {
  return { a, b, distance_m: null };
}

// Fuzzy-match a spoken phrase against a list of GPS nodes' aliases & labels.
// Used by the outdoor venue to resolve "hostel j", "j block", "main gate", etc.
/**
 * Speech recognition often writes a spoken letter as a word ("jay block",
 * "age block", "gee block") or mishears "block" ("j lock", "h black").
 * Map those back to "j block", "h block", "g block" before matching.
 */
function normalizeSpokenPlace(phrase) {
  let t = String(phrase || '').toLowerCase().trim();
  t = t.replace(/\b(?:the|a)\s+(?=[ghj]\s)/g, '');
  const LETTERS = { g: 'gee|jee|ji|gi|g\\.', h: 'aitch|age|each|ach|edge|eight|8|h\\.', j: 'jay|jai|jae|jey|j\\.' };
  for (const [letter, words] of Object.entries(LETTERS)) {
    t = t.replace(new RegExp('\\b(?:' + words + ')\\s*(?=(?:block|lock|black|plot|clock|blog)\\b)', 'g'), letter + ' ');
  }
  t = t.replace(/\b([ghj])\s*(?:lock|black|plot|clock|blog|blocks)\b/g, '$1 block');
  t = t.replace(/\b(?:convenient|convenience|conveniences)\s+(?:store|shop|stores)\b/g, 'convenience store');
  return t.replace(/\s+/g, ' ').trim();
}

function resolveGpsNode(nodes, phrase) {
  if (!nodes || !phrase) return null;
  const text = normalizeSpokenPlace(phrase);
  let best = null;
  let bestScore = 0;

  for (const node of nodes) {
    const candidates = [
      node.label,
      node.id,
      node.id.replace(/_/g, ' '),
      ...(node.aliases || [])
    ];
    for (const cand of candidates) {
      if (!cand) continue;
      const c = cand.toLowerCase().trim();
      const score = _matchScore(text, c);
      if (score > bestScore) {
        bestScore = score;
        best = node;
      }
    }
  }
  return bestScore >= 0.35 ? best : null;
}

function _matchScore(text, candidate) {
  if (text === candidate) return 2.0;
  if (text.includes(candidate)) return 1.5 + candidate.length / 100;
  if (candidate.includes(text)) return 1.2 + text.length / 100;

  const tset = new Set(text.split(/\s+/).filter(w => w.length > 1));
  const cset = candidate.split(/\s+/).filter(w => w.length > 1);
  if (!cset.length || !tset.size) return 0;

  const hits = cset.filter((tok) => tset.has(tok)).length;
  return hits / cset.length;
}

// ---------------------------------------------------------------------
// Venue registry — outdoor-hostels.js calls registerVenue() once.
// No indoor venues any more; this registry exists solely for the outdoor
// GPS anchor set.
// ---------------------------------------------------------------------
window.VENUES = {};

function registerVenue({ id, label, nodes, edges, isOutdoor }) {
  window.VENUES[id] = {
    id,
    label,
    isOutdoor: !!isOutdoor,
    nodes,   // raw array of gpsNode objects
    edges,   // raw array of gpsEdge objects (empty for outdoor_hostels)
  };
}

window.registerVenue = registerVenue;
window.resolveGpsNode = resolveGpsNode;
window.__venueHelpers = { gpsNode, gpsEdge, haversineDistance, initialBearing };

if (typeof window !== 'undefined') { window.normalizeSpokenPlace = normalizeSpokenPlace; }
if (typeof module !== 'undefined' && module.exports) { module.exports.normalizeSpokenPlace = normalizeSpokenPlace; }
