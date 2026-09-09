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
 *   G Block       → OSM node 14093702529 (G Block North Entrance on Hostel Road)
 *   H Block       → OSM node 14165878673 (H Block West Entrance on path)
 *   J Block       → OSM node 14165878669 (J Block South Foyer on Hostel Road)
 *   Main Gate     → OSM node 14165878675 (Hostel Complex Main Gate on road)
 *   Convenience Store → OSM node 14165878672 (Crossroad near J Block)
 * -----------------------------------------------------------------------
 */
(function () {
  const { gpsNode } = window.__venueHelpers;

  // Walkway-entry node coordinates from OpenStreetMap survey (map.osm)
  // surveyed by Yojasree. These are ON the pedestrian path network, not
  // inside any building, so routing works correctly from any direction.
  const CALIBRATED_COORDS = {
    hostel_g:          { lat: 12.9677686, lon: 79.1593426 }, // OSM 14093702529 — G Block North Entrance
    hostel_h:          { lat: 12.9681076, lon: 79.1595178 }, // OSM 14165878673 — H Block West Entrance
    hostel_j:          { lat: 12.9679849, lon: 79.1591590 }, // OSM 14165878669 — J Block South Foyer
    main_gate:         { lat: 12.9685617, lon: 79.1594558 }, // OSM 14165878675 — Hostel Complex Main Gate
    convenience_store: { lat: 12.9681441, lon: 79.1594053 }, // OSM 14165878672 — Crossroad near J Block
  };

  const NODES = [
    gpsNode('hostel_g',   'G Block', ['g block', 'hostel g', 'block g', 'ladies hostel g', 'g hostel', 'socrates'], true, 'Ladies Hostel G • Student Residence (17 Floors)'),
    gpsNode('hostel_h',   'H Block', ['h block', 'hostel h', 'block h', 'ladies hostel h', 'h hostel'],             true, 'Ladies Hostel H • Student Residence (17 Floors)'),
    gpsNode('hostel_j',   'J Block', ['j block', 'hostel j', 'block j', 'ladies hostel j', 'j hostel'],             true, 'Ladies Hostel J • Student Residence (17 Floors)'),
    gpsNode('main_gate',  'Main Gate', ['main gate', 'the gate', 'hostel gate', 'security gate', 'gate'],           true, 'Hostel Complex Entry & Security Checkpoint'),
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
