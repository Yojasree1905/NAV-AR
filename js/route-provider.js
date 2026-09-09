/**
 * route-provider.js
 * -----------------------------------------------------------------------
 * Fetches a real walking route between two GPS points from an open routing
 * service, and geocodes free-text place names into coordinates.
 *
 * Supported providers (set via Settings or DEFAULT_PROVIDER):
 *   'osrm'  — OSRM public demo. No key required. Walking support disputed
 *             (may return car routes). Good for quick testing.
 *   'ors'   — OpenRouteService. Free API key required. Unambiguously
 *             walking profile. Recommended for real use.
 *   'gmaps' — Google Maps Directions API. Requires a billing-enabled
 *             Google Cloud API key. Best real-world path coverage for
 *             Indian campuses. Set key via Settings → Routing.
 *
 * All providers return the same shape:
 *   { points: [[lat,lon], ...], distanceMeters, durationSeconds, steps }
 *
 * `points` is a DENSE polyline — all geometry vertices, not just
 * turn-by-turn waypoints — so the AR overlay can project the actual road
 * curve onto the camera, not just point at the next vertex.
 *
 * TWO HONEST CAVEATS (same as before, still true):
 *   1. OSRM public demo foot-routing reliability is disputed.
 *   2. Campus internal footpaths are often not in OSM. Fix: add them at
 *      openstreetmap.org. After that, OSM-based routers route through them
 *      immediately. Google Maps usually already has them.
 * -----------------------------------------------------------------------
 */

const DEFAULT_PROVIDER = 'ors';

class RouteProvider {
  constructor({ provider = DEFAULT_PROVIDER, orsApiKey = null, gmapsApiKey = null } = {}) {
    this.provider = provider;
    this.orsApiKey = orsApiKey;
    this.gmapsApiKey = gmapsApiKey;
  }

  setProvider(p) { this.provider = p; }
  setOrsKey(k)   { this.orsApiKey = k; }
  setGmapsKey(k) { this.gmapsApiKey = k; }

  /**
   * Returns { points: [[lat,lon], ...], distanceMeters, durationSeconds, steps }
   * or null on failure.
   * from / to: { lat, lon }
   */
  async getWalkingRoute(from, to) {
    try {
      // 1. High-precision surveyed campus walk route (Ladies Hostel G/H/J & Hostel Road)
      const campusRoute = this._getCampusWalkRoute(from, to);
      if (campusRoute) return campusRoute;

      // 2. Fall back to external routing APIs
      if (this.provider === 'gmaps' && this.gmapsApiKey) {
        return await this._getRouteGmaps(from, to);
      }
      if (this.provider === 'ors' && this.orsApiKey) {
        return await this._getRouteOrs(from, to);
      }
      return await this._getRouteOsrm(from, to);
    } catch (err) {
      console.warn('Route fetch failed:', err);
      return null;
    }
  }

  // ------------------------------------------------------------------
  // OSRM
  // ------------------------------------------------------------------
  async _getRouteOsrm(from, to) {
    const url =
      `https://router.project-osrm.org/route/v1/foot/` +
      `${from.lon},${from.lat};${to.lon},${to.lat}` +
      `?geometries=geojson&overview=full&steps=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes?.length) return null;

    const route = data.routes[0];
    // GeoJSON geometry is [lon,lat]; we use [lat,lon] everywhere else
    const points = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    const steps = (route.legs || []).flatMap((leg) =>
      (leg.steps || []).map((s) => ({
        instruction: _describeOsrmManeuver(s.maneuver, s.name),
        distanceMeters: s.distance,
      }))
    );
    return { points, distanceMeters: route.distance, durationSeconds: route.duration, steps };
  }

  // ------------------------------------------------------------------
  // OpenRouteService
  // ------------------------------------------------------------------
  async _getRouteOrs(from, to) {
    // ORS migrated from api.openrouteservice.org → api.heigit.org (Directions V2)
    const url = 'https://api.heigit.org/ors/v2/directions/foot-walking/geojson';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.orsApiKey },
      body: JSON.stringify({ coordinates: [[from.lon, from.lat], [to.lon, to.lat]] }),
    });
    if (!res.ok) throw new Error(`ORS HTTP ${res.status}`);
    const data = await res.json();
    const feature = data.features?.[0];
    if (!feature) return null;

    const points = feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    const summary = feature.properties.summary || {};
    const steps = (feature.properties.segments || []).flatMap((seg) =>
      (seg.steps || []).map((s) => ({ instruction: s.instruction, distanceMeters: s.distance }))
    );
    return { points, distanceMeters: summary.distance, durationSeconds: summary.duration, steps };
  }

  // ------------------------------------------------------------------
  // Google Maps Directions API
  // ------------------------------------------------------------------
  async _getRouteGmaps(from, to) {
    const params = new URLSearchParams({
      origin: `${from.lat},${from.lon}`,
      destination: `${to.lat},${to.lon}`,
      mode: 'walking',
      key: this.gmapsApiKey,
    });
    const url = `https://maps.googleapis.com/maps/api/directions/json?${params}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GMaps HTTP ${res.status}`);
    const data = await res.json();

    if (data.status !== 'OK' || !data.routes?.length) {
      console.warn('GMaps Directions:', data.status, data.error_message);
      return null;
    }

    const route = data.routes[0];
    const leg = route.legs[0];

    // Decode the overview_polyline for a dense point set
    const points = _decodePolyline(route.overview_polyline.points);

    const steps = (leg.steps || []).map((s) => ({
      instruction: s.html_instructions.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      distanceMeters: s.distance.value,
    }));

    return {
      points,
      distanceMeters: leg.distance.value,
      durationSeconds: leg.duration.value,
      steps,
    };
  }

  // ------------------------------------------------------------------
  // Nominatim geocoding — free-text place name → {lat, lon}
  // ------------------------------------------------------------------
  async geocode(query, { limit = 5, viewbox = null } = {}) {
    const params = new URLSearchParams({ q: query, format: 'json', limit: String(limit) });
    if (viewbox) params.set('viewbox', viewbox.join(','));
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.map((r) => ({
        label: r.display_name,
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon),
      }));
    } catch (err) {
      console.warn('Geocode failed:', err);
      return [];
    }
  }

  // ------------------------------------------------------------------
  // High-precision surveyed campus walk route (Ladies Hostel G/H/J)
  // Direct walkway geometry from OpenStreetMap survey (map.osm).
  // Uses ONLY real path nodes — block centroids are NOT in this graph,
  // so routing never jumps through a building to reach the road network.
  // ------------------------------------------------------------------
  _getCampusWalkRoute(from, to) {
    if (!from || !to) return null;
    const campusCenter = { lat: 12.9680, lon: 79.1593 };
    const maxRadius = 350; // meters from campus center

    const distFrom = _haversineMeters(from.lat, from.lon, campusCenter.lat, campusCenter.lon);
    const distTo   = _haversineMeters(to.lat, to.lon, campusCenter.lat, campusCenter.lon);
    if (distFrom > maxRadius || distTo > maxRadius) return null;

    // Find closest WALKWAY node to from & to
    let startNode = null;
    let endNode = null;
    let minStartD = Infinity;
    let minEndD = Infinity;

    for (const [id, n] of Object.entries(CAMPUS_WALK_NODES)) {
      const d1 = _haversineMeters(from.lat, from.lon, n.lat, n.lon);
      if (d1 < minStartD) { minStartD = d1; startNode = id; }
      const d2 = _haversineMeters(to.lat, to.lon, n.lat, n.lon);
      if (d2 < minEndD) { minEndD = d2; endNode = id; }
    }

    if (!startNode || !endNode) return null;
    if (startNode === endNode) {
      // Already at/near the destination node
      const pts = [[from.lat, from.lon], [to.lat, to.lon]];
      const d = _haversineMeters(from.lat, from.lon, to.lat, to.lon);
      return { points: pts, distanceMeters: d, durationSeconds: Math.round(d / 1.2), steps: [{ instruction: `Head toward ${CAMPUS_WALK_NODES[endNode].name}.`, distanceMeters: d }] };
    }

    // Dijkstra shortest path
    const dist = {};
    const prev = {};
    const queue = new Set(Object.keys(CAMPUS_WALK_NODES));
    for (const k of Object.keys(CAMPUS_WALK_NODES)) dist[k] = Infinity;
    dist[startNode] = 0;

    while (queue.size > 0) {
      let u = null;
      let minD = Infinity;
      for (const q of queue) {
        if (dist[q] < minD) { minD = dist[q]; u = q; }
      }
      if (u === null || u === endNode) break;
      queue.delete(u);

      const neighbors = CAMPUS_WALK_ADJ[u] || [];
      for (const nb of neighbors) {
        if (!queue.has(nb.id)) continue;
        const alt = dist[u] + nb.dist;
        if (alt < dist[nb.id]) {
          dist[nb.id] = alt;
          prev[nb.id] = u;
        }
      }
    }

    if (dist[endNode] === Infinity) return null;

    const pathIds = [];
    let curr = endNode;
    while (curr) {
      pathIds.unshift(curr);
      curr = prev[curr];
    }

    const rawPoints = pathIds.map(id => [CAMPUS_WALK_NODES[id].lat, CAMPUS_WALK_NODES[id].lon]);
    // Prepend actual GPS origin; skip duplicates closer than 1.5m
    const points = [[from.lat, from.lon]];
    for (const p of rawPoints) {
      const last = points[points.length - 1];
      if (_haversineMeters(last[0], last[1], p[0], p[1]) > 1.5) points.push(p);
    }
    // Append actual destination if meaningfully different from last path node
    const lastP = points[points.length - 1];
    if (_haversineMeters(lastP[0], lastP[1], to.lat, to.lon) > 1.5) {
      points.push([to.lat, to.lon]);
    }

    let totalDist = 0;
    for (let i = 0; i < points.length - 1; i++) {
      totalDist += _haversineMeters(points[i][0], points[i][1], points[i+1][0], points[i+1][1]);
    }

    const destName = CAMPUS_WALK_NODES[endNode]?.name || 'your destination';
    const steps = [{ instruction: `Head toward ${destName}.`, distanceMeters: totalDist }];

    return {
      points,
      distanceMeters: totalDist,
      durationSeconds: Math.round(totalDist / 1.2), // ~1.2 m/s walking speed
      steps,
    };
  }
}

// ---------------------------------------------------------------------------
// Surveyed pedestrian walkway network — Ladies Hostel G/H/J & Hostel Road
// (from map.osm). ONLY real path nodes are here — no building centroids.
// Block centroids were removed because snapping a route start/end to a
// building center creates a segment that crosses through the building
// before reaching the road network, which looks wrong on the AR overlay.
// ---------------------------------------------------------------------------
const CAMPUS_WALK_NODES = {
  '14165878668': { lat: 12.9678623, lon: 79.1591697, name: 'Hostel Road near Guest House' },
  '14165878669': { lat: 12.9679849, lon: 79.1591590, name: 'J Block South Foyer' },
  '14165878670': { lat: 12.9680110, lon: 79.1589930, name: 'J Block West Side' },
  '10032723291': { lat: 12.9683349, lon: 79.1589822, name: 'J Block North-West Corner' },
  '14165878671': { lat: 12.9683346, lon: 79.1594027, name: 'J Block North-East Bend' },
  '14165878672': { lat: 12.9681441, lon: 79.1594053, name: 'Crossroad between J & H' },
  '14165907135': { lat: 12.9680005, lon: 79.1594026, name: 'Passageway between J & H' },
  '14165878673': { lat: 12.9681076, lon: 79.1595178, name: 'H Block West Entrance' },
  '14093702530': { lat: 12.9683070, lon: 79.1595854, name: 'H Block North-West Path' },
  '14165878674': { lat: 12.9683998, lon: 79.1594990, name: 'North Road Pathway' },
  '14165878675': { lat: 12.9685617, lon: 79.1594558, name: 'Main Gate' },
  '14165878676': { lat: 12.9677647, lon: 79.1595216, name: 'Courtyard Walkway' },
  '14093702529': { lat: 12.9677686, lon: 79.1593426, name: 'G Block North Entrance' },
  '14093702528': { lat: 12.9677581, lon: 79.1598230, name: 'G Block East Road' },
};

const CAMPUS_WALK_EDGES = [
  ['14165878668', '14093702529'],
  ['14093702529', '14165878676'],
  ['14165878676', '14093702528'],
  ['14165878676', '14165878673'],
  ['14165878672', '14165907135'],
  ['14165907135', '14165878669'],
  ['14165878668', '14165878669'],
  ['14165878669', '14165878670'],
  ['14165878670', '10032723291'],
  ['10032723291', '14165878671'],
  ['14165878671', '14165878672'],
  ['14165878672', '14165878673'],
  ['14165878673', '14093702530'],
  ['14093702530', '14165878674'],
  ['14165878674', '14165878675'],
];

// Pre-compute campus walkway adjacency graph
const CAMPUS_WALK_ADJ = {};
for (const k of Object.keys(CAMPUS_WALK_NODES)) CAMPUS_WALK_ADJ[k] = [];
for (const [a, b] of CAMPUS_WALK_EDGES) {
  if (CAMPUS_WALK_NODES[a] && CAMPUS_WALK_NODES[b]) {
    const d = _haversineMeters(
      CAMPUS_WALK_NODES[a].lat, CAMPUS_WALK_NODES[a].lon,
      CAMPUS_WALK_NODES[b].lat, CAMPUS_WALK_NODES[b].lon
    );
    CAMPUS_WALK_ADJ[a].push({ id: b, dist: d });
    CAMPUS_WALK_ADJ[b].push({ id: a, dist: d });
  }
}

function _haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function _describeOsrmManeuver(maneuver, roadName) {
  const road = roadName ? ` onto ${roadName}` : '';
  switch (maneuver.type) {
    case 'depart':    return `Head out${road}`;
    case 'arrive':    return 'You have arrived';
    case 'turn':      return `Turn ${maneuver.modifier || ''}${road}`.replace(/\s+/g, ' ').trim();
    case 'new name':  return `Continue${road}`;
    case 'continue':  return `Continue straight${road}`;
    default:          return `Continue${road}`;
  }
}

/**
 * Decodes a Google Maps encoded polyline string into [[lat,lon], ...].
 * Algorithm: https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
function _decodePolyline(encoded) {
  const points = [];
  let index = 0, lat = 0, lon = 0;

  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0; result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lon += (result & 1) ? ~(result >> 1) : (result >> 1);

    points.push([lat / 1e5, lon / 1e5]);
  }
  return points;
}

/**
 * Rough sanity check: compare route distance to straight-line distance.
 * A ratio > 3 suggests the router went via roads because campus paths
 * aren't mapped yet.
 */
function checkRouteSanity(routeDistanceMeters, straightLineMeters) {
  if (straightLineMeters < 5) return { ok: true };
  const ratio = routeDistanceMeters / straightLineMeters;
  if (ratio > 3) {
    return {
      ok: false,
      reason: `The route is ${ratio.toFixed(1)}× longer than a straight line — ` +
        `it may be detouring via roads because the direct path isn't mapped yet.`,
    };
  }
  return { ok: true };
}

window.RouteProvider = RouteProvider;
window.checkRouteSanity = checkRouteSanity;
