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
    hostel_j:          { lat: 12.9680483, lon: 79.1590861 }, // OSM 14168860238 — "J Block lift" (lift entrance for luggage), 10.6m from the previous South Foyer point; treated as the same real spot on a building this size and used as the more precise, explicitly-named point. Corrected 2026-09-11.
    j_main_entrance:   { lat: 12.9683346, lon: 79.1594027 }, // OSM 14165878671 — J Block North-East Bend, confirmed by user as the actual main entrance (2026-09-10); distinct from hostel_j (the lift/side entrance) above
    main_gate:         { lat: 12.9683659, lon: 79.1595077 }, // OSM 14165878674 — "security point & main gate for hostels" (repositioned + renamed 2026-09-09)
    convenience_store: { lat: 12.9679250, lon: 79.1595513 }, // Real GPS-walked coordinate from early on-site calibration (two independent walks, accuracy-weighted) — NOT the OSM crossroad node 14165878672, which route-provider.js's own walkway graph separately and correctly labels "Crossroad between J & H". That node had been mistakenly reused as the Convenience Store's coordinate, making the two indistinguishable on screen. Corrected 2026-09-10.
  };

  // Scoped down to exactly this set 2026-09-11, per explicit request.
  // The wider campus list (Technology Tower, SJT, PRP, SMV, Library,
  // Main Block, A/B Block, MGB, 3A Gate, Main University Gate, Foodys,
  // Health Centre, Anna Auditorium) is preserved in git history if it's
  // ever wanted back — this file's history has every one of those with
  // real, individually-verified coordinates already worked out, so
  // re-adding any of them later is a small, safe change, not a redo.
  const NODES = [
    gpsNode('hostel_g',   'G Block', ['g block', 'hostel g', 'block g', 'ladies hostel g', 'g hostel', 'socrates'], true, 'Ladies Hostel G • Student Residence (17 Floors)'),
    gpsNode('hostel_h',   'H Block', ['h block', 'hostel h', 'block h', 'ladies hostel h', 'h hostel'],             true, 'Ladies Hostel H • Student Residence (17 Floors)'),
    gpsNode('hostel_j',   'J Block Lift Entrance', ['j block', 'hostel j', 'block j', 'ladies hostel j', 'j hostel', 'j block lift', 'lift entrance', 'luggage entrance'], true, 'Ladies Hostel J • Lift Entrance (for luggage)'),
    gpsNode('j_main_entrance', 'J Block Main Entrance', ['j block main entrance', 'j main entrance', 'main entrance j block'], true, 'Ladies Hostel J • Main Entrance'),
    gpsNode('main_gate',  'Hostel Gate', ['hostel gate', 'main gate', 'the gate', 'security gate', 'gate'],           true, 'Hostel Complex Entry & Security Checkpoint'),
    gpsNode('convenience_store', 'Convenience Store', ['shop', 'store', 'convenience store', 'the shop', 'snacks'], true, 'Convenience Store near J Block'),
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
