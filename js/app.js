/**
 * app.js — NAV-AR Controller
 *
 * Unified map-driven navigation:
 *   - MapDiscovery (Overpass API) finds real buildings from voice queries
 *   - RouteProvider fetches real walking routes (OSRM / ORS / Google Maps)
 *   - ArOverlay projects the route polyline onto the camera feed in real-time
 *   - HazardDetector + COCO-SSD for obstacle warnings (unchanged)
 *   - VoiceIO for "Hey Nav" wake word and TTS (unchanged)
 *   - AiAssistant for open-ended questions (unchanged)
 *
 * Routing flow:
 *   User says "take me to library"
 *     → MapDiscovery.resolveQuery() → {lat, lon}
 *     → RouteProvider.getWalkingRoute() → dense [[lat,lon]...] polyline
 *     → GPS tracker advances along polyline
 *     → ArOverlay.setRoute() draws transparent AR corridor on camera
 */

const state = {
  phase: 'unstarted', // unstarted | idle | navigating | arrived
  isAssistantRunning: false,
  outdoorPosition: null,   // last known GPS fix {lat, lon, accuracy, timestamp}
  activeRoute: null,       // { polyline, pointIndex, destLabel, totalDistance, steps }
  latestTraffic: null,
  lastAnnouncedLandmark: null,
};

const settings = {
  voiceRate: 1.0,
  audioChimes: true,
  hazardsEnabled: true,
  routingProvider: 'osrm',  // 'osrm' | 'ors' | 'gmaps'
  orsApiKey: '',
  gmapsApiKey: '',
  cameraFovH: 60,
};

const els = {};
let voice, ar, hazards, camStream;
let gpsTracker = null;
let routeProvider = null;
let mapDiscovery = null;
let aiAssistant = null;
let localizer = null;
let miniMap = null;
let webxrAr = null; // WebXrGroundAr instance, only ever active if the user explicitly opts in via the "AR Lock" button and the device actually supports it

window.addEventListener('DOMContentLoaded', init);

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------

function init() {
  _loadSettings();

  // Cache DOM elements
  els.video              = document.getElementById('camera');
  els.overlay            = document.getElementById('ar-canvas');
  els.statusText         = document.getElementById('status-text');
  els.indicatorText      = document.getElementById('indicator-text');
  els.assistantIndicator = document.getElementById('assistant-indicator');
  els.subtitle           = document.getElementById('subtitle');
  els.subtitleHud        = document.getElementById('subtitle-hud');
  els.voiceHub           = document.getElementById('voice-hub');
  els.voiceOrbWrapper    = document.querySelector('.voice-orb-wrapper');
  els.micBtn             = document.getElementById('mic-btn');
  els.voiceHint          = document.getElementById('voice-hint');
  els.routeControls      = document.getElementById('route-controls');
  els.repeatBtn          = document.getElementById('repeat-btn');
  els.nextLegBtn         = document.getElementById('next-leg-btn');
  els.stopBtn            = document.getElementById('stop-btn');
  els.webxrArBtn         = document.getElementById('webxr-ar-btn');

  // Sidebar
  els.sidebar            = document.getElementById('settings-sidebar');
  els.sidebarBackdrop    = document.getElementById('sidebar-backdrop');
  els.sidebarToggleBtn   = document.getElementById('sidebar-toggle-btn');
  els.sidebarCloseBtn    = document.getElementById('sidebar-close-btn');
  els.destList           = document.getElementById('dest-list');
  els.destFilter         = document.getElementById('dest-filter');
  els.destCountBadge     = document.getElementById('dest-count-badge');
  els.voiceRateSlider    = document.getElementById('voice-rate-slider');
  els.voiceRateVal       = document.getElementById('voice-rate-val');
  els.audioChimesToggle  = document.getElementById('audio-chimes-toggle');
  els.hazardToggle       = document.getElementById('hazard-toggle');
  els.testVoiceBtn       = document.getElementById('test-voice-btn');
  els.openaiKeyInput     = document.getElementById('openai-key-input');
  els.saveOpenaiKeyBtn   = document.getElementById('save-openai-key-btn');
  els.openaiKeyStatus    = document.getElementById('openai-key-status');
  // New routing settings
  els.routingProviderSel = document.getElementById('routing-provider-sel');
  els.orsKeyInput        = document.getElementById('ors-key-input');
  els.gmapsKeyInput      = document.getElementById('gmaps-key-input');
  els.saveRoutingBtn     = document.getElementById('save-routing-btn');
  els.cameraFovSlider    = document.getElementById('camera-fov-slider');
  els.cameraFovVal       = document.getElementById('camera-fov-val');

  // Voice assistant
  voice = new VoiceIO({
    onDestinationRequest: handleDestinationRequest,
    onStop: handleStopRequested,
    onRepeat: repeatRoute,
    onStatusRequest: announceCurrentStatus,
    onHelpRequest: announceHelp,
    onSettingsToggle: toggleSidebar,
    onStateChange: handleVoiceStateChange,
    onWakeWord: handleWakeWordDetected,
    onLocationSet: () => announceGpsPosition(),  // outdoors GPS always answers
    onNextRequested: () => voice.speak('GPS tracks your position automatically — no manual step needed.', { key: 'next-noop' }),
    onCalibrateRequested: () => toggleSidebar(true),
    onAiQuery: handleAiQuery,
  });
  voice.rate = settings.voiceRate;
  voice.chimesEnabled = settings.audioChimes;

  // OpenAI setup
  aiAssistant = new AiAssistant();
  const savedKey = localStorage.getItem('navassist_openai_key');
  if (savedKey) {
    aiAssistant.setApiKey(savedKey);
    if (els.openaiKeyInput) els.openaiKeyInput.value = savedKey;
    if (els.openaiKeyStatus) els.openaiKeyStatus.textContent = 'Key loaded from this device.';
  } else {
    if (els.openaiKeyStatus) els.openaiKeyStatus.textContent = 'No key set — AI questions won\'t work until one is added.';
  }

  _syncSettingsUI();
  _renderDestinationList(_getKnownCampusPlaces());
  _refreshNearbyPois(); // background fetch Overpass POIs around VIT Vellore

  // Mini-Map Widget
  if (typeof MiniMapController !== 'undefined') {
    miniMap = new MiniMapController();
  }

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Event wiring
  els.micBtn.addEventListener('click', onMicTapped);
  els.repeatBtn.addEventListener('click', repeatRoute);
  els.nextLegBtn.addEventListener('click', () => voice.speak('GPS tracks your position automatically.', { key: 'next-noop' }));
  els.stopBtn.addEventListener('click', handleStopRequested);
  els.webxrArBtn.addEventListener('click', toggleWebXrAr);
  els.sidebarToggleBtn.addEventListener('click', () => toggleSidebar(true));
  els.sidebarCloseBtn?.addEventListener('click', () => toggleSidebar(false));
  els.sidebarBackdrop?.addEventListener('click', () => toggleSidebar(false));

  if (els.saveOpenaiKeyBtn) els.saveOpenaiKeyBtn.addEventListener('click', handleSaveOpenaiKey);
  if (els.saveRoutingBtn)   els.saveRoutingBtn.addEventListener('click', handleSaveRoutingSettings);

  if (els.voiceRateSlider) {
    els.voiceRateSlider.addEventListener('input', (e) => {
      settings.voiceRate = parseFloat(e.target.value);
      voice.rate = settings.voiceRate;
      if (els.voiceRateVal) els.voiceRateVal.textContent = `${settings.voiceRate.toFixed(2)}×`;
      try { localStorage.setItem('navassist_rate', String(settings.voiceRate)); } catch (_) {}
    });
  }

  if (els.audioChimesToggle) {
    els.audioChimesToggle.addEventListener('change', (e) => {
      settings.audioChimes = e.target.checked;
      voice.chimesEnabled = settings.audioChimes;
      try { localStorage.setItem('navassist_chimes', String(settings.audioChimes)); } catch (_) {}
    });
  }

  if (els.hazardToggle) {
    els.hazardToggle.addEventListener('change', (e) => {
      settings.hazardsEnabled = e.target.checked;
      try { localStorage.setItem('navassist_hazards', String(settings.hazardsEnabled)); } catch (_) {}
      if (hazards) {
        settings.hazardsEnabled ? hazards.start(4) : hazards.stop();
        if (!settings.hazardsEnabled) ar && ar.setDetectedObjects([], 0, 0);
      }
    });
  }

  if (els.testVoiceBtn) {
    els.testVoiceBtn.addEventListener('click', () => {
      voice.playChime('listen');
      voice.speak('Voice assistant volume and speed test. All systems ready.', { key: 'test-voice', interrupt: true });
    });
  }

  if (els.cameraFovSlider) {
    els.cameraFovSlider.addEventListener('input', (e) => {
      settings.cameraFovH = parseInt(e.target.value, 10);
      if (els.cameraFovVal) els.cameraFovVal.textContent = `${settings.cameraFovH}°`;
      if (ar) ar.setFov(settings.cameraFovH);
      try { localStorage.setItem('navassist_fov', String(settings.cameraFovH)); } catch (_) {}
    });
  }

  if (els.destFilter) {
    els.destFilter.addEventListener('input', (e) => filterDestList(e.target.value));
    els.destFilter.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = e.target.value.trim();
        if (val) {
          toggleSidebar(false);
          if (!state.isAssistantRunning) {
            startAssistant().then(() => handleDestinationRequest(val));
          } else {
            handleDestinationRequest(val);
          }
        }
      }
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleSidebar(false);
  });

  // Update top bar label
  if (els.currentVenueLabel) els.currentVenueLabel.textContent = 'NAV-AR';
  setStatus('Starting camera…');

  // Auto-start camera immediately so the user sees live view on launch
  _autoStartCamera();
}

// ------------------------------------------------------------------
// Auto camera — starts live view immediately without needing mic tap
// ------------------------------------------------------------------
async function _autoStartCamera() {
  // NOTE: iOS Safari requires DeviceOrientationEvent.requestPermission()
  // to be called synchronously within a direct user gesture (a tap
  // handler) — calling it here, during automatic page load with no user
  // gesture, silently fails on iOS and compass data never arrives. Only
  // request it here on platforms that don't need a gesture (i.e. where
  // the check below is skipped entirely); the real request now happens
  // in the mic tap handler instead, see onMicTapped().
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    els.video.srcObject = camStream;
    await els.video.play();
  } catch (_) {
    setStatus('Tap mic to begin');
    return;
  }

  resizeCanvas();
  ar = new ArOverlay(els.overlay);
  ar.setFov(settings.cameraFovH);
  ar.start();

  if (typeof MiniMapController !== 'undefined') {
    miniMap = new MiniMapController();
    window.miniMap = miniMap; // expose globally so ar.js can update compass
  }

  setStatus('Say "Hey Nav" or tap mic');
}

// ------------------------------------------------------------------
// Settings persistence
// ------------------------------------------------------------------

function _loadSettings() {
  try {
    const r = localStorage.getItem('navassist_rate');
    if (r) settings.voiceRate = parseFloat(r) || 1.0;
    const c = localStorage.getItem('navassist_chimes');
    if (c !== null) settings.audioChimes = c === 'true';
    const h = localStorage.getItem('navassist_hazards');
    if (h !== null) settings.hazardsEnabled = h === 'true';
    const fov = localStorage.getItem('navassist_fov');
    if (fov) settings.cameraFovH = parseInt(fov, 10) || 60;
    const rp = localStorage.getItem('navassist_routing_provider');
    if (rp) settings.routingProvider = rp;
    const ok = localStorage.getItem('navassist_ors_key');
    if (ok) settings.orsApiKey = ok;
    const gk = localStorage.getItem('navassist_gmaps_key');
    if (gk) settings.gmapsApiKey = gk;
  } catch (_) {}
}

function _syncSettingsUI() {
  if (els.voiceRateSlider) {
    els.voiceRateSlider.value = settings.voiceRate;
    if (els.voiceRateVal) els.voiceRateVal.textContent = `${settings.voiceRate.toFixed(2)}×`;
  }
  if (els.audioChimesToggle) els.audioChimesToggle.checked = settings.audioChimes;
  if (els.hazardToggle)      els.hazardToggle.checked = settings.hazardsEnabled;
  if (els.routingProviderSel) els.routingProviderSel.value = settings.routingProvider;
  if (els.orsKeyInput)   els.orsKeyInput.value = settings.orsApiKey;
  if (els.gmapsKeyInput) els.gmapsKeyInput.value = settings.gmapsApiKey;
  if (els.cameraFovSlider) {
    els.cameraFovSlider.value = settings.cameraFovH;
    if (els.cameraFovVal) els.cameraFovVal.textContent = `${settings.cameraFovH}°`;
  }
}

function handleSaveRoutingSettings() {
  settings.routingProvider = els.routingProviderSel?.value || 'osrm';
  settings.orsApiKey   = els.orsKeyInput?.value.trim()   || '';
  settings.gmapsApiKey = els.gmapsKeyInput?.value.trim() || '';
  try {
    localStorage.setItem('navassist_routing_provider', settings.routingProvider);
    localStorage.setItem('navassist_ors_key',          settings.orsApiKey);
    localStorage.setItem('navassist_gmaps_key',        settings.gmapsApiKey);
  } catch (_) {}
  // Apply to live routeProvider
  if (routeProvider) {
    routeProvider.setProvider(settings.routingProvider);
    routeProvider.setOrsKey(settings.orsApiKey);
    routeProvider.setGmapsKey(settings.gmapsApiKey);
  }
  voice.speak('Routing settings saved.', { key: 'routing-saved', interrupt: true });
}

// ------------------------------------------------------------------
// Canvas
// ------------------------------------------------------------------

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  els.overlay.width  = Math.round(w * dpr);
  els.overlay.height = Math.round(h * dpr);
  els.overlay.style.width  = `${w}px`;
  els.overlay.style.height = `${h}px`;
  if (ar) ar.setDpr(dpr);
}

// ------------------------------------------------------------------
// Sidebar / Destination list
// ------------------------------------------------------------------

function toggleSidebar(open) {
  const shouldOpen = typeof open === 'boolean' ? open : !els.sidebar.classList.contains('active');
  els.sidebar.classList.toggle('active', shouldOpen);
  els.sidebarBackdrop?.classList.toggle('active', shouldOpen);
  els.sidebarToggleBtn.setAttribute('aria-expanded', String(shouldOpen));
  if (shouldOpen && els.destFilter) els.destFilter.focus();
}

let _allDestinations = [];

function _getKnownCampusPlaces() {
  const list = [];
  const outdoorVenue = window.VENUES?.['outdoor_hostels'];
  if (outdoorVenue && outdoorVenue.nodes) {
    for (const node of outdoorVenue.nodes) {
      list.push({
        name: node.label,
        aliases: node.aliases || [],
        lat: node.lat,
        lon: node.lon,
        isAnchor: true,
        purpose: node.purpose || '',
      });
    }
  }
  return list;
}

function _renderDestinationList(pois) {
  if (!els.destList) return;
  _allDestinations = (pois && pois.length) ? pois : _getKnownCampusPlaces();
  els.destList.innerHTML = '';

  if (!_allDestinations.length) {
    if (els.destCountBadge) els.destCountBadge.textContent = '0 places';
    const li = document.createElement('li');
    li.style.cssText = 'opacity:0.6; pointer-events:none; padding:12px 0;';
    li.textContent = 'Say or type any destination (e.g. "Library", "J Block", "Main Gate")';
    els.destList.appendChild(li);
    return;
  }

  if (els.destCountBadge) els.destCountBadge.textContent = `${_allDestinations.length} places`;

  for (const poi of _allDestinations) {
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.setAttribute('role', 'option');
    li.dataset.name = poi.name;
    li.dataset.aliases = (poi.aliases || []).join('|');

    const badge = poi.isAnchor
      ? '<span style="font-size:0.7rem; background:rgba(0,200,180,0.2); color:#00e5cc; padding:2px 6px; border-radius:4px; margin-left:6px; font-weight:normal;">Campus</span>'
      : '';
    const purposeTag = poi.purpose
      ? `<div style="font-size:0.72rem; color:#99f6e4; margin-top:2px;">${poi.purpose}</div>`
      : '';
    const sub = (poi.aliases && poi.aliases.length)
      ? `<div style="font-size:0.7rem; opacity:0.5; margin-top:1px;">${poi.aliases.slice(0, 3).join(', ')}</div>`
      : '';

    li.innerHTML = `
      <div style="display:flex; flex-direction:column; justify-content:center; text-align:left;">
        <div><strong>${poi.name}</strong>${badge}</div>
        ${purposeTag}
        ${sub}
      </div>
      <span class="item-arrow">→</span>
    `;

    const trigger = () => {
      toggleSidebar(false);
      if (!state.isAssistantRunning) {
        startAssistant().then(() => handleDestinationRequest(poi.name));
      } else {
        handleDestinationRequest(poi.name);
      }
    };
    li.addEventListener('click', trigger);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') trigger(); });
    els.destList.appendChild(li);
  }
}

function filterDestList(query) {
  const q = query.toLowerCase().trim();
  const items = els.destList?.querySelectorAll('li[data-name]') || [];
  let visibleCount = 0;

  // Remove existing fallback search item if any
  const existingSearchFallback = els.destList?.querySelector('.search-fallback-item');
  if (existingSearchFallback) existingSearchFallback.remove();

  items.forEach((item) => {
    const name = (item.dataset.name || '').toLowerCase();
    const aliases = (item.dataset.aliases || '').toLowerCase();
    const match = !q || name.includes(q) || aliases.includes(q);
    item.style.display = match ? 'flex' : 'none';
    if (match) visibleCount++;
  });

  if (els.destCountBadge) {
    els.destCountBadge.textContent = q ? `${visibleCount} found` : `${_allDestinations.length} places`;
  }

  // If query is typed, offer a prominent direct "Search map & route" action button
  if (q && els.destList) {
    const searchLi = document.createElement('li');
    searchLi.className = 'search-fallback-item';
    searchLi.tabIndex = 0;
    searchLi.style.cssText = 'background:rgba(59,130,246,0.18); border:1px solid rgba(59,130,246,0.4); border-radius:8px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; cursor:pointer;';
    searchLi.innerHTML = `
      <div style="text-align:left;">
        <strong style="color:#60a5fa;">🔍 Route to "${query}"</strong>
        <div style="font-size:0.75rem; opacity:0.8;">Search map & start walking route</div>
      </div>
      <span class="item-arrow" style="color:#60a5fa;">→</span>
    `;
    const triggerSearch = () => {
      toggleSidebar(false);
      if (!state.isAssistantRunning) {
        startAssistant().then(() => handleDestinationRequest(query));
      } else {
        handleDestinationRequest(query);
      }
    };
    searchLi.addEventListener('click', triggerSearch);
    searchLi.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') triggerSearch(); });
    els.destList.insertBefore(searchLi, els.destList.firstChild);
  }
}

// ------------------------------------------------------------------
// Assistant launch
// ------------------------------------------------------------------

async function onMicTapped() {
  if (!state.isAssistantRunning) {
    await startAssistant();
  }
  voice.triggerWakeMode();
}

async function startAssistant() {
  if (state.isAssistantRunning) return;
  state.isAssistantRunning = true;
  setStatus('Starting…');
  if (els.voiceHint) els.voiceHint.textContent = 'Activating assistant…';

  // This MUST run here, unconditionally, on every call — startAssistant()
  // is only ever invoked from onMicTapped(), a real user tap, which is
  // exactly the gesture context iOS Safari requires for
  // DeviceOrientationEvent.requestPermission() to work at all. It used
  // to live inside the `if (!camStream)` block below, which meant it
  // silently never ran once _autoStartCamera() had already started the
  // camera on page load — compass permission was then never requested on
  // iOS. Harmless to call again if already granted (Android doesn't
  // implement this API at all, so this is a no-op there).
  await ArOverlay.requestPermission();

  // Camera & AR — skip if already started by _autoStartCamera()
  if (!camStream) {
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      els.video.srcObject = camStream;
      await els.video.play();
    } catch (_) {
      setStatus('Voice guidance active (no camera).');
    }
  }
  if (!localizer && camStream) {
    localizer = new Localizer(els.video);
  }
  if (!ar) {
    resizeCanvas();
    ar = new ArOverlay(els.overlay);
    ar.setFov(settings.cameraFovH);
    ar.start();
  }
  if (!miniMap && typeof MiniMapController !== 'undefined') {
    miniMap = new MiniMapController();
    window.miniMap = miniMap;
  }

  // GPS tracker
  gpsTracker = new GpsTracker();
  gpsTracker.start({ onUpdate: _handleGpsUpdate, onError: _handleGpsError });

  // Routing
  routeProvider = new RouteProvider({
    provider: settings.routingProvider,
    orsApiKey:   settings.orsApiKey   || null,
    gmapsApiKey: settings.gmapsApiKey || null,
  });

  // Map discovery
  mapDiscovery = new MapDiscovery();

  voice.start();
  state.phase = 'idle';

  voice.speak(
    'Navigator ready. Say "Hey Nav" followed by any destination.',
    { key: 'ready', cooldownMs: 30000 }
  );
  setStatus('Say "Hey Nav" or tap mic');
  if (els.voiceHint) els.voiceHint.textContent = 'Say "Hey Nav" or tap mic to begin';

  // Seed destination list with nearby POIs (in background)
  _refreshNearbyPois();

  // WebXR true ground-locked AR — only reveal the button if a real
  // feature check confirms support (ARCore-capable Android Chrome).
  // Everywhere else this silently stays hidden and the app behaves
  // exactly as it already does; nothing here changes default behavior.
  if (typeof WebXrGroundAr !== 'undefined') {
    WebXrGroundAr.isSupported().then((supported) => {
      if (supported) els.webxrArBtn.classList.remove('hidden');
    });
  }

  // Hazard detector
  if (camStream && settings.hazardsEnabled) {
    hazards = new HazardDetector({
      videoEl: els.video,
      onHazard: handleHazard,
      onTrafficUpdate: (t) => { state.latestTraffic = t; },
      onDetections: (boxes, vw, vh) => {
        ar && ar.setDetectedObjects(boxes, vw, vh);
        const summary = boxes.length ? boxes.map((b) => b.label).join(',') : 'none in view';
        ar && ar.setDebugInfo(`Hazard model: OK | ${boxes.length} objects (${summary})`);
      },
    });
    setStatus('Loading hazard detector…');
    try {
      await hazards.load();
      hazards.start(4);
      ar && ar.setDebugInfo('Hazard model: OK | objects: 0 (none in view)');
    } catch (err) {
      console.error('Hazard model failed:', err);
      ar && ar.setDebugInfo('Hazard model: FAILED — see console');
      voice.speak(
        'Obstacle detection could not start. Voice navigation still works, but there will be no hazard warnings this session.',
        { key: 'hazard-load-failed', interrupt: true }
      );
    }
    setStatus('Say "Hey Nav" or tap mic');
  }
}

async function _refreshNearbyPois() {
  try {
    const campusPlaces = _getKnownCampusPlaces();
    let lat = 12.9682, lon = 79.1594;
    const fix = await getFreshGpsFix();
    if (fix && fix.lat && fix.lon) {
      lat = fix.lat;
      lon = fix.lon;
    }

    // Scoped down to just the curated campus list for now (2026-09-09) —
    // the live Overpass "nearby POI" merge (mapDiscovery.getDestinationList)
    // is what caused "99 places" in the destination list and unrelated
    // real shops/ATMs showing up as floating AR labels on real-device
    // testing. Any OTHER destination by name still works via voice —
    // handleDestinationRequest() falls back to routeProvider.geocode()
    // (Nominatim) for anything not in this list, a completely separate
    // code path from this nearby-POI feed. Re-enable the broader merge
    // below (it's just commented out, not deleted) once the curated list
    // itself is settled and worth layering more onto.
    _renderDestinationList(campusPlaces);
    ar && ar.setNearbyBuildings(campusPlaces, lat, lon);

    // if (!mapDiscovery) mapDiscovery = new MapDiscovery();
    // const mapPois = await mapDiscovery.getDestinationList(lat, lon);
    // const merged = [...campusPlaces];
    // const seen = new Set(campusPlaces.map((p) => p.name.toLowerCase()));
    // for (const p of mapPois) {
    //   const key = p.name.toLowerCase();
    //   if (!seen.has(key)) { merged.push(p); seen.add(key); }
    // }
    // _renderDestinationList(merged);
    // ar && ar.setNearbyBuildings(merged, lat, lon);
  } catch (err) {
    console.warn('Refresh POIs error:', err);
  }
}

// ------------------------------------------------------------------
// Destination handling — single unified flow
// ------------------------------------------------------------------

async function handleDestinationRequest(phraseOrLabel) {
  if (!state.isAssistantRunning) await startAssistant();

  // Resolve destination to {name, lat, lon}
  voice.speak(`Looking up ${phraseOrLabel}.`, { key: 'lookup', cooldownMs: 0 });
  setStatus(`Searching for "${phraseOrLabel}"…`);

  // 1. Check known outdoor hostel anchors first (fast, calibrated)
  const outdoorVenue = window.VENUES?.['outdoor_hostels'];
  if (outdoorVenue) {
    const gpsNode = resolveGpsNode(outdoorVenue.nodes, phraseOrLabel);
    if (gpsNode && gpsNode.lat !== null) {
      await _routeTo({ name: gpsNode.label, lat: gpsNode.lat, lon: gpsNode.lon, purpose: gpsNode.purpose || '' });
      return;
    }
  }

  // 2. MapDiscovery (Overpass + Nominatim)
  try {
    const fix = await getFreshGpsFix();
    if (!fix) {
      voice.speak("I can't get a GPS fix. Make sure location access is allowed and you're outdoors.", {
        key: 'no-gps', interrupt: true,
      });
      return;
    }
    const dest = await mapDiscovery.resolveQuery(phraseOrLabel, fix.lat, fix.lon);
    if (!dest) {
      voice.speak(
        `I couldn't find "${phraseOrLabel}" on the map. Try a different name, or be more specific.`,
        { key: 'dest-not-found', interrupt: true }
      );
      setStatus('Destination not found');
      return;
    }
    await _routeTo(dest);
  } catch (err) {
    console.error('Destination resolution failed:', err);
    voice.speak('Something went wrong looking that up. Please try again.', { key: 'lookup-error', interrupt: true });
  }
}

async function _routeTo(dest) {
  voice.speak(`Getting your GPS location.`, { key: 'gps-wait', cooldownMs: 0 });
  const fix = await getFreshGpsFix();
  if (!fix) {
    voice.speak("I can't get a GPS fix right now.", { key: 'gps-fail', interrupt: true });
    return;
  }
  state.outdoorPosition = fix;

  voice.speak(`Finding a walking route to ${dest.name}.`, { key: 'routing', cooldownMs: 0 });
  const route = await routeProvider.getWalkingRoute(fix, dest);

  if (!route || !route.points || route.points.length < 2) {
    voice.speak(
      `I couldn't find a walking route to ${dest.name}. The path there may not be mapped yet — try Google Maps routing in Settings.`,
      { key: 'no-route', interrupt: true }
    );
    setStatus('No route found');
    return;
  }

  // Sanity check
  const { haversineDistance } = window.__venueHelpers;
  const straightLine = haversineDistance(fix.lat, fix.lon, dest.lat, dest.lon);
  const sanity = window.checkRouteSanity(route.distanceMeters, straightLine);

  state.activeRoute = {
    polyline: route.points,
    pointIndex: 1,
    destLabel: dest.name,
    totalDistance: route.distanceMeters,
    steps: route.steps || [],
  };
  state.phase = 'navigating';
  els.routeControls.classList.remove('hidden');

  let msg = `Route found to ${dest.name}. About ${route.distanceMeters.toFixed(0)} metres, ${Math.round(route.durationSeconds / 60)} minutes walking.`;
  if (!sanity.ok) msg += ' ' + sanity.reason + ' Double-check before trusting it.';
  voice.speak(msg, { key: 'route-start', interrupt: true });
  setStatus(`Route: ${dest.name}`);

  // Display walking route on 3x3 Mini-Map and project road pathway in AR
  miniMap && miniMap.setRoute(route.points, dest.name, route.distanceMeters);
  ar && ar.setRoute(route.points, fix.lat, fix.lon, dest.name, route.distanceMeters, dest.purpose || '');

  // Start GPS tracking along the route
  _startGpsNav();
  _announceRouteProgress();
}

function _announceRouteProgress() {
  const route = state.activeRoute;
  if (!route) return;
  const firstStep = route.steps[0];
  const msg = firstStep ? firstStep.instruction : `Head toward ${route.destLabel}.`;
  if (els.subtitle) els.subtitle.textContent = msg;
  voice.speak(msg, { key: 'first-step', cooldownMs: 500 });
}

// ------------------------------------------------------------------
// GPS navigation tracking
// ------------------------------------------------------------------

const GPS_ARRIVAL_BASE_M = 8;
let gpsNavActive = false;

function _startGpsNav() {
  if (gpsNavActive) return;
  gpsNavActive = true;
  gpsTracker.start({ onUpdate: _handleGpsUpdate, onError: _handleGpsError });
}

function _stopGpsNav() {
  gpsNavActive = false;
  gpsTracker?.stop();
}

function _handleGpsUpdate(fix) {
  if (!fix) return;
  state.outdoorPosition = fix;

  // Always update mini-map position and AR nearby buildings
  miniMap && miniMap.updatePosition(fix.lat, fix.lon, fix.accuracy);
  ar && ar.setNearbyBuildings(_allDestinations, fix.lat, fix.lon);

  // GPS course-over-ground as compass fallback (fires when device compass unavailable)
  if (ar && fix.heading !== null && fix.heading !== undefined && !ar.hasLiveHeading) {
    ar.heading = fix.heading;
  }

  if (!gpsNavActive || state.phase !== 'navigating') return;
  const route = state.activeRoute;
  if (!route?.polyline?.length) return;

  const { haversineDistance } = window.__venueHelpers;
  const arrivalRadius = Math.max(GPS_ARRIVAL_BASE_M, (fix.accuracy || 0) * 0.6);

  // Advance past points we've already passed
  while (route.pointIndex < route.polyline.length - 1) {
    const [plat, plon] = route.polyline[route.pointIndex];
    if (haversineDistance(fix.lat, fix.lon, plat, plon) > arrivalRadius) break;
    route.pointIndex++;
  }

  const isFinal = route.pointIndex === route.polyline.length - 1;
  const [nearLat, nearLon] = route.polyline[route.pointIndex];
  const distToNext = haversineDistance(fix.lat, fix.lon, nearLat, nearLon);

  // Distance to final destination
  const [fLat, fLon] = route.polyline[route.polyline.length - 1];
  const distToEnd = haversineDistance(fix.lat, fix.lon, fLat, fLon);

  // Push live updates to mini-map and AR road projection
  miniMap && miniMap.updateRemainingDistance(distToEnd);
  ar && ar.setRoute(route.polyline.slice(route.pointIndex), fix.lat, fix.lon, route.destLabel, distToEnd);

  // Feed the same target bearing + compass heading to the WebXR ground-
  // locked session, if one is active, so its ribbon points the same
  // direction as the 2D path would.
  if (webxrAr && webxrAr.session) {
    const { initialBearing } = window.__venueHelpers;
    webxrAr.setTargetBearing(initialBearing(fix.lat, fix.lon, nearLat, nearLon));
    if (ar) webxrAr.setCompassHeading(ar.heading);
  }

  // Arrival detection
  if (isFinal && distToNext <= arrivalRadius) {
    state.phase = 'arrived';
    els.routeControls.classList.add('hidden');
    _stopGpsNav();
    ar && ar.clearActiveDestination();
    miniMap && miniMap.clearRoute();
    voice.speak(`You have arrived at ${route.destLabel}.`, { key: 'arrived', interrupt: true });
    setStatus(`Arrived at ${route.destLabel}`);
    if (els.subtitle) els.subtitle.textContent = `Arrived at ${route.destLabel}`;
    _refreshNearbyPois();
    return;
  }

  if (isFinal && distToNext <= arrivalRadius * 3) {
    voice.speak(`Almost there — about ${distToNext.toFixed(0)} metres.`, {
      key: 'almost-there', cooldownMs: 8000,
    });
  }
}

/**
 * Starts or stops the experimental WebXR ground-locked AR session.
 * See webxr-ar.js's file header for the full honest status — this is
 * unverified against real hardware, opt-in only, and any failure falls
 * back cleanly to the existing tested 2D path with a clear spoken
 * explanation, never a silent or broken state.
 */
async function toggleWebXrAr() {
  if (webxrAr && webxrAr.session) {
    await webxrAr.stop(); // triggers _restoreFrom2dFallback() via onSessionEnd below
    return;
  }

  voice.speak('Starting ground-locked AR — this is experimental.', { key: 'webxr-starting', interrupt: true });
  webxrAr = new WebXrGroundAr({
    onError: (err) => {
      voice.speak(
        "Couldn't start ground-locked AR on this device — staying with the regular path view.",
        { key: 'webxr-failed', interrupt: true }
      );
      console.warn('WebXR AR error:', err);
    },
    // Fires whenever the session ends for ANY reason — our own Exit
    // button, the OS back-gesture, permission revoked, an unexpected
    // termination. Restoring state here (not duplicated at the call
    // site of stop()) means the app can never get stuck with the video
    // hidden and no path drawn, regardless of why the session ended.
    onSessionEnd: () => _restoreFrom2dFallback(),
  });
  const started = await webxrAr.start();
  if (!started) {
    webxrAr = null;
    return;
  }

  // A real XR session is now rendering its own camera passthrough via
  // dom-overlay — hide our separate <video> feed so they don't both
  // show at once, and tell ar.js to stop drawing its own 2D path since
  // webxr-ar.js's hit-test-anchored ribbon is handling that now. Every
  // other bit of ar.js (building labels, hazard boxes) keeps running
  // exactly as before, layered on top via dom-overlay.
  if (els.video) els.video.classList.add('hidden');
  if (ar) ar.externalPathActive = true;
  els.webxrArBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg><span>Exit AR Lock</span>';
  voice.speak('Ground-locked AR active. Say "exit AR" or tap the button again to go back.', {
    key: 'webxr-on',
    interrupt: true,
  });
}

/** Restores normal 2D-canvas rendering after any WebXR AR session ends, whatever the reason. Safe to call even if a session was never really active. */
function _restoreFrom2dFallback() {
  webxrAr = null;
  if (els.video) els.video.classList.remove('hidden');
  if (ar) ar.externalPathActive = false;
  if (els.webxrArBtn) {
    els.webxrArBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l9 4.9v10.2L12 22l-9-4.9V6.9L12 2z"></path></svg><span>AR Lock</span>';
  }
  voice.speak('Ground-locked AR off.', { key: 'webxr-off', interrupt: true, cooldownMs: 500 });
}

function _handleGpsError() {
  voice.speak(
    "I can't get a GPS signal. Make sure location access is allowed and you're outdoors.",
    { key: 'gps-error', cooldownMs: 15000 }
  );
}

// ------------------------------------------------------------------
// GPS helper
// ------------------------------------------------------------------

async function getFreshGpsFix() {
  if (gpsTracker?.lastFix && Date.now() - gpsTracker.lastFix.timestamp < 5000) {
    return gpsTracker.lastFix;
  }
  if (!navigator.geolocation) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp,
      }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}

// ------------------------------------------------------------------
// Voice command handlers
// ------------------------------------------------------------------

function handleStopRequested() {
  state.phase = 'idle';
  state.activeRoute = null;
  ar && ar.clearActiveDestination();
  miniMap && miniMap.clearRoute();
  ar && ar.clearBubble();
  els.routeControls.classList.add('hidden');
  if (els.subtitle) els.subtitle.textContent = '';
  _stopGpsNav();
  voice.speak('Navigation stopped.', { key: 'stopped', interrupt: true });
  setStatus('Say "Hey Nav" or tap mic');
}

function repeatRoute() {
  if (state.phase !== 'navigating' || !state.activeRoute) {
    voice.speak('No active navigation route. Say "Hey Nav" followed by your destination.', { key: 'no-route' });
    return;
  }
  _announceRouteProgress();
}

async function announceCurrentStatus() {
  if (state.phase === 'navigating' && state.activeRoute) {
    const route = state.activeRoute;
    const { haversineDistance } = window.__venueHelpers;
    const [fLat, fLon] = route.polyline[route.polyline.length - 1];
    const dist = state.outdoorPosition
      ? haversineDistance(state.outdoorPosition.lat, state.outdoorPosition.lon, fLat, fLon)
      : null;
    const distText = dist !== null ? `About ${dist.toFixed(0)} metres remaining.` : '';
    voice.speak(`Heading toward ${route.destLabel}. ${distText}`, { key: 'status-nav', interrupt: true });
    return;
  }
  // Not navigating — report GPS position
  await announceGpsPosition();
}

async function announceGpsPosition() {
  voice.speak('Getting your GPS location.', { key: 'gps-wait' });
  const fix = await getFreshGpsFix();
  if (!fix) {
    voice.speak("I can't get a GPS fix. Make sure location access is allowed and you're outdoors.", {
      key: 'gps-fail', interrupt: true,
    });
    return;
  }
  state.outdoorPosition = fix;
  const acc = fix.accuracy > 20
    ? ` GPS accuracy here is about ${Math.round(fix.accuracy)} metres, so this is approximate.`
    : '';
  voice.speak(`GPS lock acquired.${acc} Say a destination whenever you're ready.`, {
    key: 'gps-done', interrupt: true,
  });
  setStatus('GPS lock — say a destination');
}

function announceHelp() {
  voice.speak(
    'Say "Hey Nav" followed by any place name — building, gate, canteen, hostel, library, anything. ' +
    'Say "Stop" to cancel navigation. "Repeat" to hear the last instruction again. "Where am I" for your GPS position.',
    { key: 'help', interrupt: true }
  );
}

// ------------------------------------------------------------------
// Voice UI state
// ------------------------------------------------------------------

function handleWakeWordDetected() {
  if (els.assistantIndicator) els.assistantIndicator.className = 'indicator-pill state-listening';
  if (els.indicatorText) els.indicatorText.textContent = '"Hey Nav"';
  if (els.voiceOrbWrapper) els.voiceOrbWrapper.className = 'voice-orb-wrapper listening';
  if (els.voiceHint) els.voiceHint.textContent = '⚡ "Hey Nav" heard — listening…';
}

function handleVoiceStateChange(s) {
  if (els.assistantIndicator) els.assistantIndicator.className = `indicator-pill state-${s}`;
  if (s === 'listening') {
    if (els.voiceOrbWrapper) els.voiceOrbWrapper.className = 'voice-orb-wrapper listening';
    if (els.indicatorText) els.indicatorText.textContent = 'Listening';
    if (els.voiceHint) els.voiceHint.textContent = state.phase === 'navigating' ? 'Listening for commands…' : 'Listening… say a destination';
  } else if (s === 'speaking') {
    if (els.voiceOrbWrapper) els.voiceOrbWrapper.className = 'voice-orb-wrapper speaking';
    if (els.indicatorText) els.indicatorText.textContent = 'Speaking';
    if (els.voiceHint) els.voiceHint.textContent = 'Assistant speaking…';
  } else {
    if (els.voiceOrbWrapper) els.voiceOrbWrapper.className = 'voice-orb-wrapper';
    if (els.indicatorText) els.indicatorText.textContent = state.phase === 'navigating' ? 'Navigating' : 'Ready';
    if (els.voiceHint) els.voiceHint.textContent = state.phase === 'navigating' ? 'Say "Hey Nav" or "Stop"' : 'Say "Hey Nav" or tap mic';
  }
}

// ------------------------------------------------------------------
// Hazard detection
// ------------------------------------------------------------------

function handleHazard(hazard) {
  if (!settings.hazardsEnabled) return;
  let msg;
  if (hazard.zone === 'critical') {
    msg = `${hazard.label} ahead. ${hazard.guidance || 'Stop.'}`;
    voice.playChime('hazard');
  } else if (hazard.zone === 'near') {
    msg = hazard.isHeuristic ? 'Possible steps ahead, slow down.' : `${hazard.label} nearby.`;
  } else {
    msg = `${hazard.label} in the distance.`;
  }
  const cooldownMs = hazard.zone === 'critical' ? 2500 : hazard.zone === 'near' ? 4000 : 6000;
  voice.speak(msg, {
    key: `hazard-${hazard.label}-${hazard.zone}`,
    cooldownMs,
    interrupt: hazard.zone === 'critical',
  });
}

// ------------------------------------------------------------------
// OpenAI layer
// ------------------------------------------------------------------

function handleSaveOpenaiKey() {
  const key = els.openaiKeyInput?.value.trim() || '';
  if (!key) {
    localStorage.removeItem('navassist_openai_key');
    aiAssistant?.setApiKey(null);
    if (els.openaiKeyStatus) els.openaiKeyStatus.textContent = 'Key cleared.';
    return;
  }
  if (els.openaiKeyStatus) {
    els.openaiKeyStatus.textContent = key.startsWith('sk-')
      ? 'Key saved to this device.'
      : 'Saved (doesn\'t look like an OpenAI key — double-check it).';
  }
  localStorage.setItem('navassist_openai_key', key);
  if (!aiAssistant) aiAssistant = new AiAssistant();
  aiAssistant.setApiKey(key);
}

function _buildAiContext() {
  const ctx = {};
  if (state.phase === 'navigating' && state.activeRoute) {
    ctx.destination = state.activeRoute.destLabel;
    if (state.outdoorPosition) {
      const { haversineDistance } = window.__venueHelpers;
      const [fLat, fLon] = state.activeRoute.polyline[state.activeRoute.polyline.length - 1];
      ctx.distanceRemaining = haversineDistance(
        state.outdoorPosition.lat, state.outdoorPosition.lon, fLat, fLon
      );
    }
  }
  if (state.outdoorPosition) ctx.position = state.outdoorPosition;
  if (hazards?.latestSnapshot) {
    ctx.hazard  = hazards.latestSnapshot.hazard;
    ctx.traffic = hazards.latestSnapshot.traffic;
  }
  return ctx;
}

async function handleAiQuery(question) {
  if (!aiAssistant) {
    voice.speak("The AI assistant hasn't started yet. Tap Start first.", { key: 'ai-not-ready' });
    return;
  }
  if (!aiAssistant.hasKey()) {
    voice.speak('Add an OpenAI key in Settings to use this.', { key: 'ai-no-key', interrupt: true });
    return;
  }
  voice.speak('Let me check.', { key: 'ai-thinking', cooldownMs: 0 });
  const answer = await aiAssistant.ask(question, _buildAiContext());
  voice.speak(answer, { key: 'ai-answer', interrupt: true });
}

// ------------------------------------------------------------------
// Utility
// ------------------------------------------------------------------

function setStatus(text) {
  if (els.statusText) els.statusText.textContent = text;
}
