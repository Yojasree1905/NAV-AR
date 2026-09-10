/**
 * venues/outdoor-hostels.js
 * -----------------------------------------------------------------------
 * Authoritative GPS destinations for the Ladies Hostel complex (G, H, J)
 * at VIT Vellore. Only 5 real, professionally named locations.
 *
 * Coordinates point to the walkway ENTRY NODE nearest to each building
 * (from the OpenStreetMap survey in map.osm), NOT the building centroid.
 * This is critical: routing from a building centroid causes the path to
 * cross through the building structure before reaching the road network.
 *
 * A newer OSM export (2026-09-09, later edits) also added full building
 * *outline* ways for G/H/J (with real building:levels tags) — useful
 * context, but their centroids were deliberately NOT used here, for the
 * same reason above: a building's true center is usually inside the
 * building, not on the path network. Checked each entry point against
 * the newer export before updating anything: G Block's and J Block's
 * entry nodes are byte-for-byte unchanged; only H Block's moved (a ~5m
 * refinement) and Main Gate was intentionally repositioned and properly
 * named — both applied below, the unchanged ones left alone.
 *
 *   G Block       → OSM node 14165878673 (on path near G Block; name/node pairing corrected 2026-09-10, see below)
 *   H Block       → OSM node 14093702529 (on path near H Block; name/node pairing corrected 2026-09-10, see below)
 *   J Block       → OSM node 14165878669 (J Block South Foyer on Hostel Road) — unaffected by the G/H swap
 *   Main Gate     → OSM node 14165878674, named "security point & main gate for hostels" — repositioned ~22m + renamed, 2026-09-09
 *   Convenience Store → OSM node 14165878672 (Crossroad near J Block) — moved <2m, within GPS noise, left as-is
 * -----------------------------------------------------------------------
 */
(function () {
  const { gpsNode } = window.__venueHelpers;

  // Walkway-entry node coordinates from OpenStreetMap survey (map.osm)
  // surveyed by Yojasree. These are ON the pedestrian path network, not
  // inside any building, so routing works correctly from any direction.
  //
  // 2026-09-10 correction: G Block and H Block's names had been swapped
  // relative to their actual buildings. A newer OSM export (map__7_.osm)
  // shows the building NAME tags were corrected at the source — the same
  // two way IDs (1095528323, 1095528324) kept their real-world positions,
  // only which name belonged to which building changed. Verified this
  // geographically before touching anything: our old hostel_g entry point
  // sits 19m from the now-correctly-named H Block building but 49m from
  // G Block, and vice versa for hostel_h — confirming the entry points
  // themselves were always correct, only the g/h labels attached to them
  // were swapped. Fixed by swapping which coordinate hostel_g and
  // hostel_h point to; the underlying OSM node IDs are unchanged.
  const CALIBRATED_COORDS = {
    hostel_g:          { lat: 12.9681514, lon: 79.1595125 }, // OSM 14165878673 — was mislabeled "H Block West Entrance", corrected 2026-09-10
    hostel_h:          { lat: 12.9677686, lon: 79.1593426 }, // OSM 14093702529 — was mislabeled "G Block North Entrance", corrected 2026-09-10
    hostel_j:          { lat: 12.9679849, lon: 79.1591590 }, // OSM 14165878669 — J Block South Foyer (unaffected by the G/H swap)
    main_gate:         { lat: 12.9683659, lon: 79.1595077 }, // OSM 14165878674 — "security point & main gate for hostels" (repositioned + renamed 2026-09-09)
    convenience_store: { lat: 12.9681441, lon: 79.1594053 }, // OSM 14165878672 — Crossroad near J Block

    // Wider-campus buildings, added 2026-09-10 per explicit request to
    // scope the recognized-building list to exactly this set. Real
    // coordinates from the campus-wide OSM export (way/relation
    // centroids — these are simple named buildings, not routing-critical
    // hostel entry points, so a centroid is the right kind of point here
    // unlike G/H/J above.
    tech_tower:  { lat: 12.9706484, lon: 79.1594702 }, // relation/21134208
    sjt:         { lat: 12.9710043, lon: 79.1638453 }, // relation/20995799 — Silver Jubilee Tower
    prp:         { lat: 12.9712457, lon: 79.1662772 }, // way/1542862452 — Perl Research Park
    smv:         { lat: 12.9691421, lon: 79.1577164 }, // relation/20827200 — Sir M Visvesvaraya Block (OSM short_name: "SMV Block")
    library:     { lat: 12.9693316, lon: 79.1568478 }, // way/93175156 — EV Periyar Library
    main_block:  { lat: 12.9692257, lon: 79.1558494 }, // relation/14938176 — Main Building
    foodys:      { lat: 12.9690152, lon: 79.1583048 }, // way/93175238
    health_centre: { lat: 12.9695284, lon: 79.1546460 }, // way/370765052
    anna_auditorium: { lat: 12.9699782, lon: 79.1556379 }, // way/1548342976
  };

  const NODES = [
    gpsNode('hostel_g',   'G Block', ['g block', 'hostel g', 'block g', 'ladies hostel g', 'g hostel', 'socrates'], true, 'Ladies Hostel G • Student Residence (17 Floors)'),
    gpsNode('hostel_h',   'H Block', ['h block', 'hostel h', 'block h', 'ladies hostel h', 'h hostel'],             true, 'Ladies Hostel H • Student Residence (17 Floors)'),
    gpsNode('hostel_j',   'J Block', ['j block', 'hostel j', 'block j', 'ladies hostel j', 'j hostel'],             true, 'Ladies Hostel J • Student Residence (17 Floors)'),
    gpsNode('main_gate',  'Main Gate', ['main gate', 'the gate', 'hostel gate', 'security gate', 'gate'],           true, 'Hostel Complex Entry & Security Checkpoint'),
    gpsNode('convenience_store', 'Convenience Store', ['shop', 'store', 'convenience store', 'the shop', 'snacks'], true, 'Convenience Store near J Block'),
    gpsNode('tech_tower', 'Technology Tower', ['technology tower', 'tech tower', 'tt'], true, 'Academic Building • Technology Tower (7 Floors)'),
    gpsNode('sjt', 'Silver Jubilee Tower', ['sjt', 'silver jubilee tower'], true, 'Academic Building • SJT (9 Floors)'),
    gpsNode('prp', 'Perl Research Park', ['prp', 'perl research park', 'research park'], true, 'Research Building • PRP (8 Floors)'),
    gpsNode('smv', 'Sir M Visvesvaraya Block', ['smv', 'sir m visvesvaraya block', 'smv block'], true, 'Academic Building • SMV Block (2 Floors)'),
    gpsNode('library', 'Library', ['library', 'ev periyar library', 'the library'], true, 'EV Periyar Library'),
    gpsNode('main_block', 'Main Block', ['main block', 'main building'], true, 'University Main Building (3 Floors)'),
    gpsNode('foodys', 'Foodys', ['foodys', 'foody\'s'], true, 'Campus Food Shelter'),
    gpsNode('health_centre', 'Health Centre', ['health centre', 'health center', 'hospital', 'medical centre'], true, 'Sri Narayani Hospital and Research Centre'),
    gpsNode('anna_auditorium', 'Anna Auditorium', ['anna auditorium', 'auditorium', 'anna audi'], true, 'Conference & Event Auditorium'),
  ];

  // Apply calibrated walkway-entry coordinates
  for (const node of NODES) {
    const coords = CALIBRATED_COORDS[node.id];
    if (coords) {
      node.lat = coords.lat;
      node.lon = coords.lon;
    }
  }

  window.registerVenue({
    id: 'outdoor_hostels',
    label: 'Outdoor — Hostel Paths (G / H / J)',
    defaultStart: null,
    isOutdoor: true,
    nodes: NODES,
    edges: [],
  });
})();
