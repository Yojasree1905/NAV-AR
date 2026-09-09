/**
 * mini-map.js
 * -----------------------------------------------------------------------
 * Interactive Mini-Map widget for NAV-AR:
 *   - Freely draggable across the screen via touch/mouse drag.
 *   - OpenStreetMap tiles (100% free, no API key, no watermark).
 *   - Live user GPS tracking with pulsing blue beacon.
 *   - Route polyline & destination flag.
 *   - Smooth tap-to-expand (6x6) and collapse (3x3).
 *   - Live compass integration.
 * -----------------------------------------------------------------------
 */

class MiniMapController {
  constructor() {
    this.container = document.getElementById('mini-map-card');
    this.mapEl = document.getElementById('mini-map');
    this.expandBtn = document.getElementById('mini-map-expand-btn');
    this.closeBtn = document.getElementById('mini-map-close-btn');
    this.distBadge = document.getElementById('mini-map-dist-badge');
    this.compassEl = document.getElementById('mini-compass-dial');
    this.isExpanded = false;

    this.map = null;
    this.userMarker = null;
    this.userCircle = null;
    this.destMarker = null;
    this.routePolyline = null;
    this.currentPosition = null;
    this.activeRoute = null;

    this._initMap();
    this._wireEvents();
    this._makeDraggable();
  }

  _initMap() {
    if (typeof L === 'undefined' || !this.mapEl) return;

    // Default center at VIT Vellore campus
    const defaultCenter = [12.9682, 79.1594];

    this.map = L.map(this.mapEl, {
      zoomControl: false,
      attributionControl: false,
      center: defaultCenter,
      zoom: 17,
      maxZoom: 19,
    });

    // 100% Free Public OpenStreetMap tiles (NO API key, NO watermark)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      subdomains: ['a', 'b', 'c'],
    }).addTo(this.map);

    // Custom user location beacon icon
    const userIcon = L.divIcon({
      className: 'user-gps-beacon',
      html: '<div class="beacon-pulse"></div><div class="beacon-dot"></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });

    this.userMarker = L.marker(defaultCenter, { icon: userIcon }).addTo(this.map);

    // Accuracy circle
    this.userCircle = L.circle(defaultCenter, {
      radius: 12,
      color: '#00e5cc',
      fillColor: '#00e5cc',
      fillOpacity: 0.15,
      weight: 1.5,
    }).addTo(this.map);
  }

  _wireEvents() {
    if (!this.container) return;

    this.container.addEventListener('click', (e) => {
      // Don't expand if dragging just occurred or clicking close button
      if (this._didDrag) {
        this._didDrag = false;
        return;
      }
      if (e.target.closest('#mini-map-close-btn')) return;
      if (!this.isExpanded) {
        this.expand();
      }
    });

    if (this.closeBtn) {
      this.closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.collapse();
      });
    }
  }

  _makeDraggable() {
    const el = this.container;
    if (!el) return;

    let isDragging = false;
    let startX, startY;
    let origLeft, origTop;
    this._didDrag = false;

    // Clamp helper — ensures element stays within viewport
    const clampToViewport = () => {
      const w = el.offsetWidth  || 110;
      const h = el.offsetHeight || 110;
      const maxW = window.innerWidth  - w - 8;
      const maxH = window.innerHeight - h - 8;
      const curLeft = parseFloat(el.style.left);
      const curTop  = parseFloat(el.style.top);
      if (!isNaN(curLeft)) el.style.left = `${Math.max(8, Math.min(maxW, curLeft))}px`;
      if (!isNaN(curTop))  el.style.top  = `${Math.max(50, Math.min(maxH, curTop))}px`;
    };

    // Re-clamp whenever viewport resizes (e.g. phone rotation)
    window.addEventListener('resize', clampToViewport, { passive: true });

    // Double-tap to reset to default top-right corner position
    let lastTap = 0;
    el.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTap < 300) {
        el.style.transition = 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)';
        el.style.right = '14px';
        el.style.top   = '72px';
        el.style.left  = 'auto';
        el.style.bottom = 'auto';
        setTimeout(() => { el.style.transition = ''; }, 350);
      }
      lastTap = now;
    }, { passive: true });

    const onPointerDown = (clientX, clientY, target) => {
      if (this.isExpanded) return; // don't drag when expanded full modal
      if (target.closest('.mini-map-btn')) return;

      isDragging = true;
      this._didDrag = false;
      startX = clientX;
      startY = clientY;

      const rect = el.getBoundingClientRect();
      origLeft = rect.left;
      origTop = rect.top;

      // Switch to left/top positioning from right/top
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.left = `${origLeft}px`;
      el.style.top = `${origTop}px`;
      el.style.transition = 'none';
    };

    const onPointerMove = (clientX, clientY) => {
      if (!isDragging) return;
      const dx = clientX - startX;
      const dy = clientY - startY;

      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        this._didDrag = true;
      }

      const w = el.offsetWidth  || 110;
      const h = el.offsetHeight || 110;
      const maxW = window.innerWidth  - w - 8;
      const maxH = window.innerHeight - h - 8;
      const newLeft = Math.max(8, Math.min(maxW, origLeft + dx));
      const newTop  = Math.max(50, Math.min(maxH, origTop + dy));

      el.style.left = `${newLeft}px`;
      el.style.top  = `${newTop}px`;
    };

    const onPointerUp = () => {
      if (!isDragging) return;
      isDragging = false;
      el.style.transition = '';
      clampToViewport(); // final clamp in case of fast swipe
    };

    // Touch events for mobile
    el.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      onPointerDown(touch.clientX, touch.clientY, e.target);
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      const touch = e.touches[0];
      onPointerMove(touch.clientX, touch.clientY);
    }, { passive: true });

    window.addEventListener('touchend', onPointerUp);

    // Mouse events for desktop testing
    el.addEventListener('mousedown', (e) => {
      onPointerDown(e.clientX, e.clientY, e.target);
    });

    window.addEventListener('mousemove', (e) => {
      onPointerMove(e.clientX, e.clientY);
    });

    window.addEventListener('mouseup', onPointerUp);
  }

  updateCompass(headingDeg) {
    if (this.compassEl && typeof headingDeg === 'number') {
      this.compassEl.style.transform = `rotate(${-headingDeg}deg)`;
    }
  }

  expand() {
    this.isExpanded = true;
    this.container.classList.add('expanded');
    // Force the safe top-right anchor the CSS .expanded rule expects —
    // otherwise a stale inline left/top from an earlier drag (set by the
    // drag handler below) overrides the CSS `right` anchor once `width`
    // is no longer `auto`, and the expanded box can render partly or
    // fully off-screen with no way to drag it back (isExpanded blocks
    // dragging). Real-device finding: reproduced by dragging the small
    // widget near the right edge, then tapping to expand.
    this.container.style.left = 'auto';
    this.container.style.bottom = 'auto';
    this.container.style.top = '68px';
    this.container.style.right = '12px';
    if (this.expandBtn) this.expandBtn.style.display = 'none';
    if (this.closeBtn) this.closeBtn.style.display = 'flex';

    setTimeout(() => {
      this.map && this.map.invalidateSize();
      this.fitView();
    }, 280);
  }

  collapse() {
    this.isExpanded = false;
    this.container.classList.remove('expanded');
    if (this.expandBtn) this.expandBtn.style.display = 'flex';
    if (this.closeBtn) this.closeBtn.style.display = 'none';

    setTimeout(() => {
      this.map && this.map.invalidateSize();
      this.fitView();
    }, 280);
  }

  updatePosition(lat, lon, accuracy = 10) {
    this.currentPosition = { lat, lon };
    if (!this.map || !this.userMarker) return;

    const latlng = [lat, lon];
    this.userMarker.setLatLng(latlng);
    if (this.userCircle) {
      this.userCircle.setLatLng(latlng);
      this.userCircle.setRadius(Math.max(8, accuracy));
    }

    if (!this.activeRoute) {
      this.map.panTo(latlng, { animate: true, duration: 0.5 });
    }
  }

  setRoute(polyline, destName, distanceMeters) {
    if (!this.map) return;
    this.activeRoute = { polyline, destName };

    this.container.style.display = 'block';

    if (this.routePolyline) {
      this.map.removeLayer(this.routePolyline);
      this.routePolyline = null;
    }
    if (this.destMarker) {
      this.map.removeLayer(this.destMarker);
      this.destMarker = null;
    }

    if (!polyline || polyline.length < 2) return;

    this.routePolyline = L.polyline(polyline, {
      color: '#00e5cc',
      weight: 5,
      opacity: 0.95,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(this.map);

    const lastPoint = polyline[polyline.length - 1];
    const destIcon = L.divIcon({
      className: 'dest-flag-pin',
      html: `<div class="flag-bubble">🎯 ${destName || 'Destination'}</div><div class="flag-stem"></div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 30],
    });

    this.destMarker = L.marker(lastPoint, { icon: destIcon }).addTo(this.map);

    if (this.distBadge) {
      this.distBadge.textContent = distanceMeters < 1000
        ? `${Math.round(distanceMeters)}m`
        : `${(distanceMeters / 1000).toFixed(1)}km`;
      this.distBadge.style.display = 'block';
    }

    this.fitView();
  }

  updateRemainingDistance(distanceMeters) {
    if (this.distBadge && distanceMeters != null) {
      this.distBadge.textContent = distanceMeters < 1000
        ? `${Math.round(distanceMeters)}m`
        : `${(distanceMeters / 1000).toFixed(1)}km`;
    }
  }

  clearRoute() {
    this.activeRoute = null;
    if (this.routePolyline && this.map) {
      this.map.removeLayer(this.routePolyline);
      this.routePolyline = null;
    }
    if (this.destMarker && this.map) {
      this.map.removeLayer(this.destMarker);
      this.destMarker = null;
    }
    if (this.distBadge) {
      this.distBadge.style.display = 'none';
    }
    if (this.currentPosition && this.map) {
      this.map.setView([this.currentPosition.lat, this.currentPosition.lon], 17);
    }
  }

  fitView() {
    if (!this.map) return;
    if (this.routePolyline) {
      this.map.fitBounds(this.routePolyline.getBounds(), {
        padding: this.isExpanded ? [30, 30] : [10, 10],
        maxZoom: 18,
      });
    } else if (this.currentPosition) {
      this.map.setView([this.currentPosition.lat, this.currentPosition.lon], this.isExpanded ? 18 : 17);
    }
  }
}

window.MiniMapController = MiniMapController;
