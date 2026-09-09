/**
 * webxr-ar.js
 * -----------------------------------------------------------------------
 * True plane-locked AR: the ground path is anchored to a real detected
 * surface via WebXR hit-testing, instead of the heading+pitch illusion
 * in ar.js. This is what actually matches "the path sits on the real
 * road and stays there as the camera moves" — a compass/pitch trick
 * can approximate that, this is the real thing.
 *
 * HONEST STATUS: this file follows the WebXR Device API and WebXR
 * Hit Test API specs as I understand them, but I have NO way to test a
 * real `immersive-ar` session in this environment — no ARCore hardware,
 * and headless Chromium doesn't support real AR sessions. Every other
 * feature shipped this session was verified with real rendering or a
 * reproduced bug before/after; this one hasn't been, and can't be, by
 * me. Treat it as a first draft that needs real on-device testing on an
 * ARCore-capable Android phone in Chrome, not a confirmed feature.
 *
 * HARD PLATFORM LIMIT (not a bug, a browser/OS restriction): this only
 * works on ARCore-capable Android phones in Chrome. iOS Safari does not
 * implement WebXR at all. On any unsupported device, `isSupported()`
 * below returns false and nothing about this file ever activates — the
 * app just keeps using ar.js's existing, tested illusion.
 *
 * SCOPE: rather than trying to continuously reconcile GPS-based route
 * waypoints (world-scale, absolute coordinates) with WebXR's local
 * tracking space (relative to wherever the session started, no GPS tie-
 * in), which is a much harder full sensor-fusion problem, this does the
 * more tractable version: hit-test along the direction the camera is
 * pointing to find the real ground surface, and anchor a directional
 * ribbon there oriented toward the next route point's compass bearing.
 * Re-queried periodically so it stays reasonably attached to real ground
 * as you walk, without claiming to be a full continuously-tracked path.
 *
 * INTEGRATION: uses the `dom-overlay` WebXR feature so the existing HTML
 * UI (buttons, mini-map, top bar, building labels — all untouched, still
 * rendered by ar.js's 2D canvas) keeps working exactly as before; only
 * the camera feed and the ground-path ribbon come from the XR session
 * instead of the <video> element and ar.js's 2D path drawing.
 * -----------------------------------------------------------------------
 */

class WebXrGroundAr {
  constructor({ onError, onSessionEnd } = {}) {
    this.session = null;
    this.gl = null;
    this.refSpace = null;
    this.viewerSpace = null;
    this.hitTestSource = null;
    this.glCanvas = null;
    this.onError = onError || (() => {});
    this.onSessionEnd = onSessionEnd || (() => {}); // called on ANY session end, not just our own stop() -- covers the OS back-gesture / permission-revoked / unexpected-termination cases too
    this._program = null;
    this._lastHitPose = null;
    this._targetBearing = null; // set via setTargetBearing(), degrees true-north
    this._compassHeading = null; // best-effort, from the same deviceorientation listener ar.js uses
    this._rafHandle = null;
  }

  /** Feature-detect only — never assume, always check. Safe to call on any device/browser. */
  static async isSupported() {
    try {
      if (!navigator.xr || typeof navigator.xr.isSessionSupported !== 'function') return false;
      return await navigator.xr.isSessionSupported('immersive-ar');
    } catch (_) {
      return false;
    }
  }

  setTargetBearing(bearingDeg) {
    this._targetBearing = bearingDeg;
  }

  setCompassHeading(headingDeg) {
    this._compassHeading = headingDeg;
  }

  /**
   * Starts an immersive-ar session. Must be called from a real user
   * gesture (a tap handler) — the WebXR spec requires this, sessions
   * cannot be started programmatically on page load the way the camera
   * auto-start elsewhere in this app works.
   * Returns true on success, false on any failure (and calls onError)
   * — callers should keep the existing 2D fallback active until this
   * resolves true.
   */
  async start() {
    try {
      const supported = await WebXrGroundAr.isSupported();
      if (!supported) {
        this.onError(new Error('WebXR immersive-ar not supported on this device/browser.'));
        return false;
      }

      this.session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['dom-overlay'],
        domOverlay: { root: document.body },
      });

      this.glCanvas = document.createElement('canvas');
      this.glCanvas.id = 'webxr-canvas';
      this.glCanvas.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; z-index:5;';
      document.body.appendChild(this.glCanvas);

      this.gl = this.glCanvas.getContext('webgl', { xrCompatible: true });
      if (!this.gl) throw new Error('WebGL context unavailable.');
      await this.gl.makeXRCompatible();

      this.session.updateRenderState({
        baseLayer: new XRWebGLLayer(this.session, this.gl),
      });

      // 'local-floor' gives a ground-relative origin when available (more
      // accurate for a ground path); fall back to 'local' if the device
      // doesn't support floor-relative tracking.
      try {
        this.refSpace = await this.session.requestReferenceSpace('local-floor');
      } catch (_) {
        this.refSpace = await this.session.requestReferenceSpace('local');
      }
      this.viewerSpace = await this.session.requestReferenceSpace('viewer');
      this.hitTestSource = await this.session.requestHitTestSource({ space: this.viewerSpace });

      this._initGl();
      this.session.addEventListener('end', () => this._onSessionEnd());
      this._rafHandle = this.session.requestAnimationFrame((t, f) => this._onXrFrame(t, f));
      return true;
    } catch (err) {
      console.warn('WebXR AR session failed to start:', err);
      this.onError(err);
      await this._cleanup();
      return false;
    }
  }

  /** Ends the session and restores the app to its normal (tested) 2D rendering. Safe to call even if a session was never successfully started. */
  async stop() {
    if (this.session) {
      try { await this.session.end(); } catch (_) { /* already ending/ended */ }
    }
    await this._cleanup();
  }

  _onSessionEnd() {
    this._cleanup();
    this.onSessionEnd();
  }

  async _cleanup() {
    this.hitTestSource = null;
    this.refSpace = null;
    this.viewerSpace = null;
    this.session = null;
    if (this.glCanvas && this.glCanvas.parentNode) this.glCanvas.parentNode.removeChild(this.glCanvas);
    this.glCanvas = null;
    this.gl = null;
  }

  _initGl() {
    const gl = this.gl;
    const vsSource = `
      attribute vec3 aPosition;
      uniform mat4 uViewMatrix;
      uniform mat4 uProjMatrix;
      void main() {
        gl_Position = uProjMatrix * uViewMatrix * vec4(aPosition, 1.0);
      }
    `;
    const fsSource = `
      precision mediump float;
      uniform vec4 uColor;
      void main() {
        gl_FragColor = uColor;
      }
    `;
    const vs = this._compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = this._compileShader(gl.FRAGMENT_SHADER, fsSource);
    this._program = gl.createProgram();
    gl.attachShader(this._program, vs);
    gl.attachShader(this._program, fs);
    gl.linkProgram(this._program);
    if (!gl.getProgramParameter(this._program, gl.LINK_STATUS)) {
      throw new Error('WebXR shader program link failed: ' + gl.getProgramInfoLog(this._program));
    }
    this._posLoc = gl.getAttribLocation(this._program, 'aPosition');
    this._viewLoc = gl.getUniformLocation(this._program, 'uViewMatrix');
    this._projLoc = gl.getUniformLocation(this._program, 'uProjMatrix');
    this._colorLoc = gl.getUniformLocation(this._program, 'uColor');
    this._vbo = gl.createBuffer();
  }

  _compileShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('WebXR shader compile failed: ' + log);
    }
    return shader;
  }

  _onXrFrame(t, frame) {
    const session = frame.session;
    this._rafHandle = session.requestAnimationFrame((tt, ff) => this._onXrFrame(tt, ff));

    const pose = frame.getViewerPose(this.refSpace);
    if (!pose) return; // tracking lost this frame — skip, try again next frame

    const glLayer = session.renderState.baseLayer;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, glLayer.framebuffer);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Refresh the hit-test result this frame; only redraw the ribbon if
    // we actually have a real detected ground point to anchor it to —
    // never fabricate a position when hit-testing comes back empty.
    if (this.hitTestSource) {
      const hitResults = frame.getHitTestResults(this.hitTestSource);
      if (hitResults.length > 0) {
        this._lastHitPose = hitResults[0].getPose(this.refSpace);
      }
    }

    for (const view of pose.views) {
      const viewport = glLayer.getViewport(view);
      gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
      if (this._lastHitPose) {
        this._drawGroundRibbon(view, this._lastHitPose);
      }
    }
  }

  /**
   * Draws a short directional ribbon flat on the detected ground plane,
   * anchored at the last real hit-test position, oriented toward the
   * target compass bearing if known (falls back to pointing straight
   * ahead from the hit point if no bearing/heading data is available
   * yet). This intentionally does NOT try to render the entire multi-
   * point route in WebXR space — see the file header for why that's a
   * substantially harder problem left out of this first pass.
   */
  _drawGroundRibbon(view, hitPose) {
    const gl = this.gl;
    const p = hitPose.transform.position;

    // Orient the ribbon along the target bearing relative to compass
    // heading, same convention ar.js's 2D path already uses — if either
    // is unavailable yet, default to pointing straight ahead (rel = 0).
    let relRad = 0;
    if (this._targetBearing !== null && this._compassHeading !== null) {
      let rel = this._targetBearing - this._compassHeading;
      rel = ((rel + 540) % 360) - 180;
      relRad = (rel * Math.PI) / 180;
    }

    const length = 2.0; // meters, a short forward segment from the hit point
    const halfWidth = 0.4; // meters
    const dx = Math.sin(relRad);
    const dz = -Math.cos(relRad); // WebXR: -Z is typically "forward"
    const nx = -dz; // perpendicular, for ribbon width
    const nz = dx;

    const y = p.y + 0.01; // a hair above the detected surface, avoids z-fighting with the real ground
    const verts = new Float32Array([
      p.x - nx * halfWidth, y, p.z - nz * halfWidth,
      p.x + nx * halfWidth, y, p.z + nz * halfWidth,
      p.x + dx * length - nx * halfWidth, y, p.z + dz * length - nz * halfWidth,
      p.x + dx * length - nx * halfWidth, y, p.z + dz * length - nz * halfWidth,
      p.x + dx * length + nx * halfWidth, y, p.z + dz * length + nz * halfWidth,
      p.x - nx * halfWidth, y, p.z - nz * halfWidth,
    ]);

    gl.useProgram(this._program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this._posLoc);
    gl.vertexAttribPointer(this._posLoc, 3, gl.FLOAT, false, 0, 0);

    gl.uniformMatrix4fv(this._viewLoc, false, view.transform.inverse.matrix);
    gl.uniformMatrix4fv(this._projLoc, false, view.projectionMatrix);
    gl.uniform4f(this._colorLoc, 0.0, 0.9, 0.8, 0.55); // teal, semi-transparent — matches ar.js's path color

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}

window.WebXrGroundAr = WebXrGroundAr;
