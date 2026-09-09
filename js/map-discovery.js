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

// Exact surveyed campus POIs from map.osm (Ladies Hostel G, H, J, Guest House, Parking, Gate, Mess)
const CAMPUS_SURVEYED_POIS = [
  {
    id: 'node/14165878677',
    name: 'Ladies Hostel J',
    lat: 12.9681335,
    lon: 79.1591946,
    type: 'dormitory',
    purpose: 'Student Residence • Ladies Hostel J (17 Floors)',
    tags: { 'building:levels': '17', name: 'J Block', amenity: 'dormitory' },
    aliases: ['j block', 'hostel j', 'block j', 'j hostel']
  },
  {
    id: 'way/1095528323',
    name: 'Ladies Hostel H',
    lat: 12.9680394,
    lon: 79.1596759,
    type: 'dormitory',
    purpose: 'Student Residence • Ladies Hostel H (17 Floors)',
    tags: { 'building:levels': '17', name: 'H Block', amenity: 'dormitory' },
    aliases: ['h block', 'hostel h', 'block h', 'h hostel']
  },
  {
    id: 'way/1095528324',
    name: 'Ladies Hostel G',
    lat: 12.9676012,
    lon: 79.1594861,
    type: 'dormitory',
    purpose: 'Student Residence • Ladies Hostel G (17 Floors)',
    tags: { 'building:levels': '17', name: 'G Block', amenity: 'dormitory' },
    aliases: ['g block', 'hostel g', 'block g', 'g hostel', 'socrates block']
  },
  {
    id: 'relation/21227412',
    name: 'VIT Guest House',
    lat: 12.9677940,
    lon: 79.1588970,
    type: 'guest_house',
    purpose: 'Visitor & VIP Guest Accommodation',
    tags: { tourism: 'guest_house', name: 'VIT Guest House' },
    aliases: ['guest house', 'campus guest house', 'guesthouse']
  },
  {
    id: 'node/5487048824',
    name: 'Campus Parking Area',
    lat: 12.9676287,
    lon: 79.1592126,
    type: 'parking',
    purpose: 'Designated Vehicle & Visitor Parking Area',
    tags: { amenity: 'parking' },
    aliases: ['parking', 'car parking', 'parking lot']
  },
  {
    id: 'node/14165878675',
    name: 'Hostel Complex Main Gate',
    lat: 12.9685617,
    lon: 79.1594558,
    type: 'gate',
    purpose: 'Campus Road Entry & 24/7 Security Checkpoint',
    tags: { barrier: 'gate' },
    aliases: ['main gate', 'hostel gate', 'the gate', 'security gate']
  },
  {
    id: 'node/14165878676',
    name: 'Hostel Dining Mess',
    lat: 12.9677647,
    lon: 79.1595216,
    type: 'canteen',
    purpose: 'Dining Hall & Meal Services for Residents',
    tags: { amenity: 'canteen' },
    aliases: ['mess', 'dining hall', 'mess entrance', 'food court']
  },

  // Extended from the wider campus survey (map.osm, ~353m x 622m bounding
  // box) — real coordinates parsed directly from the OSM export, not
  // hand-typed, to avoid transcription errors. Way centroids are the
  // average of that building's outline nodes, same method used for
  // G/H/J above.
  {
    id: 'way/370766286',
    name: 'B Block',
    lat: 12.9679410,
    lon: 79.1581289,
    type: 'dormitory',
    purpose: 'Student Residence • B Block (7 Floors)',
    tags: { 'building:levels': '7', name: 'B Block', building: 'dormitory' },
    aliases: ['b block', 'hostel b', 'block b']
  },
  {
    id: 'way/93175156',
    name: 'EV Periyar Library',
    lat: 12.9693316,
    lon: 79.1568478,
    type: 'library',
    purpose: 'Central Library • 3 Floors',
    tags: { amenity: 'library', 'building:levels': '3', name: 'EV Periyar Library' },
    aliases: ['library', 'periyar library', 'central library']
  },
  {
    id: 'way/1548342976',
    name: 'Anna Auditorium',
    lat: 12.9699782,
    lon: 79.1556379,
    type: 'auditorium',
    purpose: 'Conference & Event Auditorium',
    tags: { amenity: 'conference_centre', name: 'Anna Auditorium' },
    aliases: ['anna auditorium', 'auditorium', 'anna audi']
  },
  {
    id: 'way/370765052',
    name: 'Health Centre',
    lat: 12.9695284,
    lon: 79.1546460,
    type: 'hospital',
    purpose: 'Campus Hospital (Sri Narayani Hospital & Research Centre)',
    tags: { amenity: 'hospital', healthcare: 'hospital', name: 'Health Centre' },
    aliases: ['health centre', 'health center', 'hospital', 'medical centre', 'clinic']
  },
  {
    id: 'way/370764917',
    name: 'CDMM Building',
    lat: 12.9692179,
    lon: 79.1549807,
    type: 'college',
    purpose: 'Academic Building — CDMM',
    tags: { building: 'college', name: 'CDMM Building' },
    aliases: ['cdmm', 'cdmm building']
  },
  {
    id: 'way/93175045',
    name: 'CS Hall',
    lat: 12.9701567,
    lon: 79.1557119,
    type: 'building',
    purpose: 'Academic / Event Hall — CS Hall',
    tags: { building: 'yes', name: 'CS Hall' },
    aliases: ['cs hall']
  },
  {
    id: 'way/93127404',
    name: 'VIT Univ Estates Office & CTS',
    lat: 12.9701936,
    lon: 79.1562660,
    type: 'college',
    purpose: 'Estates Office & Campus Technical Services',
    tags: { building: 'college', name: 'VIT Univ Estates Office & CTS' },
    aliases: ['estates office', 'cts office']
  },
  {
    id: 'way/556538991',
    name: 'Food Court',
    lat: 12.9700197,
    lon: 79.1589702,
    type: 'restaurant',
    purpose: 'Campus Food Court',
    tags: { amenity: 'restaurant', name: 'Food Court' },
    aliases: ['food court', 'the food court']
  },
  {
    id: 'way/556538990',
    name: 'DC Bakery',
    lat: 12.9700742,
    lon: 79.1588762,
    type: 'cafe',
    purpose: 'Bakery & Cafe',
    tags: { amenity: 'cafe', name: 'DC Bakery' },
    aliases: ['dc bakery', 'bakery']
  },
  {
    id: 'node/1619807760',
    name: 'HDFC Bank ATM',
    lat: 12.9697492,
    lon: 79.1551859,
    type: 'atm',
    purpose: 'HDFC Bank ATM • 24/7 Cash Withdrawal',
    tags: { amenity: 'atm', brand: 'HDFC Bank', name: 'HDFC Bank' },
    aliases: ['hdfc', 'hdfc bank', 'hdfc atm']
  },
  {
    id: 'node/1064558843',
    name: 'Indian Bank',
    lat: 12.9699373,
    lon: 79.1543436,
    type: 'bank',
    purpose: 'Indian Bank Branch & ATM',
    tags: { amenity: 'bank', brand: 'Indian Bank', name: 'Indian Bank' },
    aliases: ['indian bank']
  },
  {
    id: 'way/570870179',
    name: 'Kalpana Chawla Ground',
    lat: 12.9684196,
    lon: 79.1565637,
    type: 'park',
    purpose: 'Open Ground for Casual Activities',
    tags: { leisure: 'park', name: 'Kalpana Chawla Ground' },
    aliases: ['kalpana chawla ground', 'the ground', 'flag ground']
  },
  {
    id: 'way/149737160',
    name: 'VIT Lake',
    lat: 12.9697059,
    lon: 79.1604820,
    type: 'water',
    purpose: 'Campus Lake',
    tags: { natural: 'water', name: 'VIT Lake' },
    aliases: ['vit lake', 'the lake']
  },
  {
    id: 'node/1619807763',
    name: 'Main Gate Fountain',
    lat: 12.9686493,
    lon: 79.1559337,
    type: 'landmark',
    purpose: 'Fountain Landmark near Main Gate',
    tags: { amenity: 'fountain', name: 'Main Gate Fountain' },
    aliases: ['main gate fountain', 'the fountain']
  }
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
