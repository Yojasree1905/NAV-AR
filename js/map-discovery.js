/**
 * map-discovery.js
 * -----------------------------------------------------------------------
 * Discovers real buildings, amenities, and landmarks near the user using
 * the Overpass API (OpenStreetMap's free query interface — no key, no
 * billing). Falls back to Nominatim geocoding for anything not found in
 * the local area query.
 *
 * This replaces the hand-authored node graphs (sjt-7th-floor.js, etc.)
 * for destination discovery. The actual ROUTE between two points still
 * comes from route-provider.js; this module only answers "what is at
 * coordinates X,Y?" and "what coordinates does 'the library' map to?"
 *
 * Results are cached in localStorage (24h TTL) so a campus walk doesn't
 * fire a new network request every time the user speaks a destination.
 * -----------------------------------------------------------------------
 */

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const CACHE_KEY = 'navassist_map_discovery_cache';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Overpass tags we care about for campus navigation
const OVERPASS_FILTERS = [
  '["amenity"]',
  '["building"]',
  '["shop"]',
  '["barrier"="gate"]',
  '["highway"="bus_stop"]',
  '["leisure"]',
  '["tourism"]',
  '["office"]',
];

// Real surveyed campus POIs — walkway entry coordinates from map.osm
// Coordinates match outdoor-hostels.js (walkway entry nodes, not building centroids)
const CAMPUS_SURVEYED_POIS = [
  {
    // Node/coordinate corrected 2026-09-10: this node had been mislabeled
    // "H Block" — it's actually the entry point closest to G Block. See
    // outdoor-hostels.js's header comment for how this was verified
    // (geographic distance check against the corrected OSM building
    // outlines) before swapping.
    id: 'node/14165878673',
    name: 'G Block',
    lat: 12.9681514,
    lon: 79.1595125,
    type: 'dormitory',
    purpose: 'Ladies Hostel G • Student Residence (17 Floors)',
    tags: { building: 'dormitory', name: 'G Block' },
    aliases: ['hostel g', 'g hostel', 'ladies hostel g', 'block g', 'socrates'],
  },
  {
    // Node/coordinate corrected 2026-09-10: this node had been mislabeled
    // "G Block" — it's actually the entry point closest to H Block.
    id: 'node/14093702529',
    name: 'H Block',
    lat: 12.9677686,
    lon: 79.1593426,
    type: 'dormitory',
    purpose: 'Ladies Hostel H • Student Residence (17 Floors)',
    tags: { building: 'dormitory', name: 'H Block' },
    aliases: ['hostel h', 'h hostel', 'ladies hostel h', 'block h'],
  },
  {
    id: 'node/14165878669',
    name: 'J Block',
    lat: 12.9679849,
    lon: 79.1591590,
    type: 'dormitory',
    purpose: 'Ladies Hostel J • Student Residence (17 Floors)',
    tags: { building: 'dormitory', name: 'J Block' },
    aliases: ['hostel j', 'j hostel', 'ladies hostel j', 'block j'],
  },
  {
    id: 'node/14165878674',
    name: 'Main Gate',
    lat: 12.9683659,
    lon: 79.1595077,
    type: 'gate',
    purpose: 'Hostel Complex Entry & Security Checkpoint',
    tags: { barrier: 'gate', name: 'security point & main gate for hostels' },
    aliases: ['main gate', 'hostel gate', 'the gate', 'security gate', 'gate', 'security point'],
  },
  {
    // Real GPS-walked coordinate (see outdoor-hostels.js for the full
    // explanation) -- was previously reusing OSM node 14165878672, which
    // is actually route-provider.js's "Crossroad between J & H" waypoint,
    // not the shop. Corrected 2026-09-10.
    id: 'gps-walked/convenience-store-north',
    name: 'Convenience Store',
    lat: 12.9679250,
    lon: 79.1595513,
    type: 'shop',
    purpose: 'Convenience Store near J Block',
    tags: { shop: 'convenience', name: 'Convenience Store' },
    aliases: ['shop', 'store', 'the shop', 'snacks', 'convenience store'],
  },
  {
    id: 'node/14165878671',
    name: 'J Block Main Entrance',
    lat: 12.9683346,
    lon: 79.1594027,
    type: 'dormitory',
    purpose: 'Ladies Hostel J • Main Entrance',
    tags: { building: 'dormitory', name: 'J Block Main Entrance' },
    aliases: ['j block main entrance', 'j main entrance', 'main entrance j block'],
  },

  // Wider-campus buildings, added 2026-09-10 per explicit request to
  // scope the recognized-building list to exactly this set (kept in
  // sync with the same 9 entries in outdoor-hostels.js). Real
  // coordinates from the campus-wide OSM export.
  {
    id: 'relation/21134208',
    name: 'Technology Tower',
    lat: 12.9706484,
    lon: 79.1594702,
    type: 'university',
    purpose: 'Academic Building • Technology Tower (7 Floors)',
    tags: { building: 'university', name: 'Technology Tower' },
    aliases: ['technology tower', 'tech tower', 'tt'],
  },
  {
    id: 'relation/20995799',
    name: 'Silver Jubilee Tower',
    lat: 12.9710043,
    lon: 79.1638453,
    type: 'university',
    purpose: 'Academic Building • SJT (9 Floors)',
    tags: { building: 'university', name: 'Silver Jubilee Tower' },
    aliases: ['sjt', 'silver jubilee tower'],
  },
  {
    id: 'way/1542862452',
    name: 'Perl Research Park',
    lat: 12.9712457,
    lon: 79.1662772,
    type: 'university',
    purpose: 'Research Building • PRP (8 Floors)',
    tags: { building: 'university', name: 'Perl Research Park' },
    aliases: ['prp', 'perl research park', 'research park'],
  },
  {
    id: 'relation/20827200',
    name: 'Sir M Visvesvaraya Block',
    lat: 12.9691421,
    lon: 79.1577164,
    type: 'university',
    purpose: 'Academic Building • SMV Block (2 Floors)',
    tags: { building: 'university', name: 'Sir M Visvesvaraya Block', short_name: 'SMV Block' },
    aliases: ['smv', 'sir m visvesvaraya block', 'smv block'],
  },
  {
    id: 'way/93175156',
    name: 'Library',
    lat: 12.9693316,
    lon: 79.1568478,
    type: 'library',
    purpose: 'EV Periyar Library',
    tags: { amenity: 'library', name: 'EV Periyar Library' },
    aliases: ['library', 'ev periyar library', 'the library'],
  },
  {
    id: 'relation/14938176',
    name: 'Main Block',
    lat: 12.9692257,
    lon: 79.1558494,
    type: 'university',
    purpose: 'University Main Building (3 Floors)',
    tags: { building: 'university', name: 'Main Building' },
    aliases: ['main block', 'main building'],
  },
  {
    id: 'way/93175238',
    name: 'Foodys',
    lat: 12.9690152,
    lon: 79.1583048,
    type: 'shelter',
    purpose: 'Campus Food Shelter',
    tags: { amenity: 'shelter', name: 'Foodys' },
    aliases: ['foodys', "foody's"],
  },
  {
    id: 'way/370765052',
    name: 'Health Centre',
    lat: 12.9695284,
    lon: 79.1546460,
    type: 'hospital',
    purpose: 'Sri Narayani Hospital and Research Centre',
    tags: { amenity: 'hospital', name: 'Health Centre' },
    aliases: ['health centre', 'health center', 'hospital', 'medical centre'],
  },
  {
    id: 'way/1548342976',
    name: 'Anna Auditorium',
    lat: 12.9699782,
    lon: 79.1556379,
    type: 'conference_centre',
    purpose: 'Conference & Event Auditorium',
    tags: { amenity: 'conference_centre', name: 'Anna Auditorium' },
    aliases: ['anna auditorium', 'auditorium', 'anna audi'],
  },
  {
    id: 'relation/20992887',
    name: 'A Block',
    lat: 12.9683037,
    lon: 79.1583144,
    type: 'dormitory',
    purpose: 'Ladies Hostel A Block (7 Floors)',
    tags: { building: 'dormitory', name: 'A Block' },
    aliases: ['a block', 'block a', 'ladies hostel a', 'ladies a block'],
  },
  {
    id: 'way/370766286',
    name: 'B Block',
    lat: 12.9679410,
    lon: 79.1581289,
    type: 'dormitory',
    purpose: 'Ladies Hostel B Block (7 Floors)',
    tags: { building: 'dormitory', name: 'B Block' },
    aliases: ['b block', 'block b', 'ladies hostel b', 'ladies b block'],
  },
  {
    id: 'way/741165347',
    name: 'Mahatma Gandhi Block',
    lat: 12.9721148,
    lon: 79.1678485,
    type: 'university',
    purpose: 'Academic Building • MGB',
    tags: { building: 'yes', name: 'Mahatma Gandhi Block (MGB)' },
    aliases: ['mgb', 'mahatma gandhi block'],
  },
  {
    id: 'way/1530184785',
    name: '3A Gate',
    lat: 12.9676309,
    lon: 79.1585197,
    type: 'gate',
    purpose: 'Campus Entry Gate 3A',
    tags: { building: 'yes', name: '3A Gate' },
    aliases: ['3a gate', 'third a gate', 'gate 3a'],
  },
  {
    id: 'way/1555145366',
    name: 'Main University Gate',
    lat: 12.9683509,
    lon: 79.1556778,
    type: 'gate',
    purpose: 'Main University Entrance Gate',
    tags: { building: 'yes', name: 'Main Gate UNI Entrance' },
    aliases: ['main entrance', 'university gate', 'main university gate', 'uni entrance', 'uni gate'],
  },
];

class MapDiscovery {
  constructor() {
    this._cache = null; // {fetchedAt, lat, lon, radius, results:[]}
    this._loadCache();
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  /**
   * Returns POI results near (lat, lon) within radiusM meters.
   * Uses cache if the last fetch was close enough and fresh enough.
   * Each result: { id, name, lat, lon, type, tags }
   */
  async searchNearby(lat, lon, radiusM = 800) {
    let results = [];
    if (this._isCacheValid(lat, lon, radiusM)) {
      results = this._cache.results;
    } else {
      try {
        results = await this._fetchOverpass(lat, lon, radiusM);
        this._cache = {
          fetchedAt: Date.now(),
          lat, lon, radius: radiusM,
          results,
        };
        this._saveCache();
      } catch (e) {
        results = [];
      }
    }

    // Merge surveyed campus POIs if within range
    const campusDist = _haversineMeters(lat, lon, 12.9680, 79.1593);
    if (campusDist <= (radiusM + 1000)) {
      const seen = new Set(results.map(r => r.name.toLowerCase()));
      for (const cp of CAMPUS_SURVEYED_POIS) {
        if (!seen.has(cp.name.toLowerCase())) {
          results.unshift(cp);
          seen.add(cp.name.toLowerCase());
        }
      }
    }

    return results;
  }

  /**
   * Resolves a free-text voice query (e.g. "library", "main gate",
   * "canteen") to { name, lat, lon } using:
   *   1. Fuzzy-match against cached Overpass results (fast, offline-ish)
   *   2. Nominatim geocoding as fallback (network required)
   * Returns null if nothing is found.
   */
  async resolveQuery(query, lat, lon) {
    // Try local POI search first (no extra network call if cached)
    try {
      const nearby = await this.searchNearby(lat, lon, 1000);
      const match = this._fuzzyMatch(query, nearby);
      if (match) return { name: match.name, lat: match.lat, lon: match.lon, purpose: match.purpose || '' };
    } catch (_) {
      // Overpass failed or timed out — fall through to Nominatim
    }

    // Nominatim fallback: biased toward the area around the user
    return this._nominatimSearch(query, lat, lon);
  }

  /**
   * Returns a list of POIs sorted by relevance to the query string,
   * for populating the destination list in the sidebar.
   */
  async getDestinationList(lat, lon) {
    try {
      const results = await this.searchNearby(lat, lon, 800);
      // Filter to things with real names and return them sorted
      return results
        .filter((r) => r.name && r.name.trim().length > 2)
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (_) {
      return [];
    }
  }

  // -------------------------------------------------------------------
  // Overpass API
  // -------------------------------------------------------------------

  async _fetchOverpass(lat, lon, radiusM) {
    // Build bounding box: lat/lon ± rough degree equivalent of radiusM
    const degOffset = radiusM / 111000;
    const south = lat - degOffset;
    const north = lat + degOffset;
    const west = lon - degOffset;
    const east = lon + degOffset;
    const bbox = `${south},${west},${north},${east}`;

    const filterLines = OVERPASS_FILTERS.flatMap((f) => [
      `  node${f}(${bbox});`,
      `  way${f}(${bbox});`,
    ]).join('\n');

    const query = `[out:json][timeout:12];\n(\n${filterLines}\n);\nout center tags;`;

    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
    });

    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
    const data = await res.json();

    const results = [];
    for (const el of data.elements || []) {
      const name = el.tags?.name || el.tags?.['alt_name'] || el.tags?.['old_name'];
      if (!name) continue; // skip unnamed features

      // Ways have a center object; nodes have lat/lon directly
      const elLat = el.type === 'way' ? el.center?.lat : el.lat;
      const elLon = el.type === 'way' ? el.center?.lon : el.lon;
      if (!elLat || !elLon) continue;

      const rawType = el.tags?.amenity || el.tags?.building || el.tags?.shop
            || el.tags?.barrier || el.tags?.highway || el.tags?.leisure
            || el.tags?.tourism || el.tags?.office || 'place';
      const purpose = _derivePurpose(name, el.tags || {});

      results.push({
        id: `${el.type}/${el.id}`,
        name,
        lat: elLat,
        lon: elLon,
        type: rawType,
        purpose,
        tags: el.tags || {},
      });
    }

    // Deduplicate by name (ways and their entrance nodes often both appear)
    const seen = new Set();
    return results.filter((r) => {
      const key = r.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // -------------------------------------------------------------------
  // Nominatim geocoding fallback
  // -------------------------------------------------------------------

  async _nominatimSearch(query, lat, lon) {
    try {
      const degOffset = 0.02; // ~2km viewbox bias toward user's area
      const viewbox = [
        lon - degOffset,
        lat + degOffset,
        lon + degOffset,
        lat - degOffset,
      ].join(',');

      const params = new URLSearchParams({
        q: query,
        format: 'json',
        limit: '5',
        viewbox,
        bounded: '0',
      });

      const res = await fetch(`${NOMINATIM_URL}?${params}`);
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.length) return null;

      const best = data[0];
      return {
        name: best.display_name.split(',')[0].trim(),
        lat: parseFloat(best.lat),
        lon: parseFloat(best.lon),
      };
    } catch (_) {
      return null;
    }
  }

  // -------------------------------------------------------------------
  // Fuzzy matching — same word-overlap approach as the old venue-graph
  // -------------------------------------------------------------------

  _fuzzyMatch(query, pois) {
    const q = query.toLowerCase().trim();
    let best = null;
    let bestScore = 0;

    for (const poi of pois) {
      const nameFields = [
        poi.name,
        ...(poi.aliases || []),
        poi.tags?.['alt_name'],
        poi.tags?.['old_name'],
        poi.tags?.description,
        poi.type,
      ].filter(Boolean);

      for (const field of nameFields) {
        const score = this._matchScore(q, field.toLowerCase());
        if (score > bestScore) {
          bestScore = score;
          best = poi;
        }
      }
    }

    // Require at least a decent partial match (0.4) to avoid returning
    // a totally unrelated place just because it's the closest string
    return bestScore >= 0.4 ? best : null;
  }

  _matchScore(text, candidate) {
    if (text === candidate) return 2;
    if (candidate.includes(text)) return 1.5;
    if (text.includes(candidate)) return 1 + candidate.length / 100;

    // Word-overlap fallback
    const tWords = new Set(text.split(/\s+/).filter((w) => w.length > 2));
    const cWords = candidate.split(/\s+/).filter((w) => w.length > 2);
    if (!cWords.length) return 0;
    const hits = cWords.filter((w) => tWords.has(w)).length;
    return hits / cWords.length;
  }

  // -------------------------------------------------------------------
  // Cache helpers
  // -------------------------------------------------------------------

  _isCacheValid(lat, lon, radiusM) {
    if (!this._cache) return false;
    if (Date.now() - this._cache.fetchedAt > CACHE_TTL_MS) return false;
    // Reuse if query is within the previously-fetched area
    const dist = _haversineMeters(lat, lon, this._cache.lat, this._cache.lon);
    return dist + radiusM <= this._cache.radius * 1.5;
  }

  _loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) this._cache = JSON.parse(raw);
    } catch (_) { this._cache = null; }
  }

  _saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(this._cache));
    } catch (_) {}
  }

  /** Invalidate cache (call when the user moves far from their last known area) */
  clearCache() {
    this._cache = null;
    try { localStorage.removeItem(CACHE_KEY); } catch (_) {}
  }
}

/** Haversine distance in meters between two lat/lon points — local copy
 *  so this module doesn't depend on venue-graph.js being loaded first. */
function _haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _derivePurpose(name, tags) {
  const n = (name || '').toLowerCase();
  const amenity = (tags.amenity || '').toLowerCase();
  const building = (tags.building || '').toLowerCase();
  const shop = (tags.shop || '').toLowerCase();
  const barrier = (tags.barrier || '').toLowerCase();

  if (n.includes('library') || amenity === 'library') return 'Academic Library & Research Study Halls';
  if (n.includes('hostel') || n.includes('block') || building === 'dormitory' || building === 'residential') return 'Student Residence & Living Quarters';
  if (n.includes('mess') || n.includes('canteen') || n.includes('food') || ['canteen', 'food_court', 'restaurant', 'cafe', 'fast_food'].includes(amenity)) return 'Dining Hall & Meal Services';
  if (n.includes('gate') || barrier === 'gate') return 'Campus Entry & Security Checkpoint';
  if (n.includes('store') || n.includes('mart') || shop) return 'Stationery, Grocery & Daily Student Essentials';
  if (n.includes('audi') || amenity === 'theatre' || building === 'auditorium') return 'Conferences, Cultural Events & Assemblies';
  if (n.includes('lab') || building === 'university' || building === 'college') return 'Academic Departments, Lecture Halls & Labs';
  if (n.includes('guest') || tags.tourism === 'hotel') return 'Visitor & Guest Accommodation';
  if (n.includes('park') || tags.leisure) return 'Student Recreation & Green Space';
  if (amenity === 'hospital' || amenity === 'clinic' || amenity === 'pharmacy') return 'Campus Health Centre & First Aid';
  if (amenity === 'bank' || amenity === 'atm') return 'Financial Services & Automated Teller Machine';
  return 'University Campus Building & Facility';
}

window.MapDiscovery = MapDiscovery;
