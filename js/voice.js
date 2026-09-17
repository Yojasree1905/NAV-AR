/**
 * voice.js
 * -----------------------------------------------------------------------
 * Voice Assistant Speech Engine with "Hey Nav" Wake Word & Crash Recovery:
 *   - Wake Word Activation: "Hey Nav" (or "Nav", "Hi Nav", "Ok Nav") triggers
 *     active listening, supporting both compound commands ("Hey Nav, where is
 *     room 715") and two-stage interaction ("Hey Nav" -> "I'm listening").
 *   - Crash Prevention: Safe debounced restart backoff, prevents infinite
 *     restart loops, InvalidStateError, and browser tab freezes.
 *   - Acoustic Loop Suppression: Speech recognition results are paused/ignored
 *     while synthesized guidance is speaking to prevent hearing itself.
 *   - Utterance GC Protection: Keeps active utterance references so Chrome's
 *     speechSynthesis doesn't freeze or drop audio callbacks.
 *   - Web Audio Earcons: Melodic feedback tones for wake, confirm, and alert.
 * -----------------------------------------------------------------------
 */

class VoiceIO {
  constructor({
    onDestinationRequest,
    onStop,
    onRepeat,
    onStatusRequest,
    onHelpRequest,
    onSettingsToggle,
    onStateChange,
    onWakeWord,
    onLocationSet,
    onNextRequested,
    onCalibrateRequested,
    onAiQuery,
    onBuildingIdQuery,
  } = {}) {
    this.onDestinationRequest = onDestinationRequest;
    this.onStop = onStop;
    this.onRepeat = onRepeat;
    this.onStatusRequest = onStatusRequest;
    this.onHelpRequest = onHelpRequest;
    this.onSettingsToggle = onSettingsToggle;
    this.onStateChange = onStateChange;
    this.onWakeWord = onWakeWord;
    this.onLocationSet = onLocationSet; // (placePhrase) => void — "I'm at the lift"
    this.onNextRequested = onNextRequested; // () => void — manual leg-advance fallback
    this.onCalibrateRequested = onCalibrateRequested; // () => void — open outdoor calibration panel
    this.onAiQuery = onAiQuery; // (question) => void — open-ended question for the OpenAI layer
    this.onBuildingIdQuery = onBuildingIdQuery; // () => void — "what building is this" one-shot camera snapshot query

    this.synth = window.speechSynthesis;
    this.lastSpokenAt = new Map();
    this.lastSpokenText = '';
    this.recognition = null;
    this.listening = false;
    this.rate = 1.02;
    this.pitch = 1.0;
    this.chimesEnabled = true;

    // Wake word state
    this.wakeWordActive = false;
    this._wakeTimeout = null;
    this.isSpeaking = false;

    // Crash prevention flags
    this._isStarting = false;
    this._isRecognizing = false;
    this._restartTimer = null;

    if (!window.__activeUtterances) {
      window.__activeUtterances = new Set();
    }

    this._audioCtx = null;
    this._initAudio();
    this._initRecognition();
  }

  _initAudio() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        this._audioCtx = new AudioContext();
      }
    } catch (_) {}
  }

  playChime(type = 'listen') {
    if (!this.chimesEnabled || !this._audioCtx) return;
    try {
      if (this._audioCtx.state === 'suspended') {
        this._audioCtx.resume();
      }
      const now = this._audioCtx.currentTime;
      const osc = this._audioCtx.createOscillator();
      const gain = this._audioCtx.createGain();
      osc.connect(gain);
      gain.connect(this._audioCtx.destination);

      if (type === 'wake') {
        // Bright two-tone chime when "Hey Nav" is heard
        osc.type = 'sine';
        osc.frequency.setValueAtTime(523.25, now); // C5
        osc.frequency.setValueAtTime(783.99, now + 0.1); // G5
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
        osc.start(now);
        osc.stop(now + 0.28);
      } else if (type === 'listen') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, now); // D5
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.12); // A5
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        osc.start(now);
        osc.stop(now + 0.22);
      } else if (type === 'success') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(523.25, now);
        osc.frequency.setValueAtTime(659.25, now + 0.08);
        osc.frequency.setValueAtTime(783.99, now + 0.16);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
        osc.start(now);
        osc.stop(now + 0.32);
      } else if (type === 'hazard') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.exponentialRampToValueAtTime(330, now + 0.18);
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
        osc.start(now);
        osc.stop(now + 0.25);
      } else if (type === 'stop') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(660, now);
        osc.frequency.exponentialRampToValueAtTime(440, now + 0.18);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        osc.start(now);
        osc.stop(now + 0.22);
      }
    } catch (_) {}
  }

  _initRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      console.warn('SpeechRecognition not supported in this browser.');
      return;
    }

    try {
      this.recognition = new SR();
      this.recognition.continuous = true;
      this.recognition.interimResults = false;
      this.recognition.maxAlternatives = 1;
      this.recognition.lang = navigator.language || 'en-US';

      this.recognition.onstart = () => {
        this._isStarting = false;
        this._isRecognizing = true;
        if (!this.wakeWordActive) {
          this._emitState('idle');
        }
      };

      this.recognition.onresult = (event) => {
        if (!event.results || event.results.length === 0) return;
        const last = event.results[event.results.length - 1];
        if (!last || !last[0]) return;
        const transcript = last[0].transcript.trim();
        this._handleTranscript(transcript);
      };

      this.recognition.onend = () => {
        this._isStarting = false;
        this._isRecognizing = false;
        if (this.listening) {
          this._scheduleRestart(350);
        } else {
          this._emitState('idle');
        }
      };

      this.recognition.onerror = (e) => {
        this._isStarting = false;
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          console.warn('Microphone permission or service denied:', e.error);
          this.listening = false;
          this._emitState('error');
          return;
        }
        if (e.error !== 'no-speech' && e.error !== 'aborted') {
          console.warn('Speech recognition notice:', e.error);
        }
        if (this.listening) {
          this._scheduleRestart(500);
        }
      };
    } catch (err) {
      console.error('SpeechRecognition initialization error:', err);
    }
  }

  _safeStart() {
    if (!this.recognition || !this.listening || this._isRecognizing || this._isStarting) return;
    this._isStarting = true;
    try {
      this.recognition.start();
    } catch (err) {
      this._isStarting = false;
      if (err.name === 'InvalidStateError') {
        this._isRecognizing = true;
      } else {
        this._scheduleRestart(800);
      }
    }
  }

  _scheduleRestart(delay = 400) {
    if (this._restartTimer) clearTimeout(this._restartTimer);
    if (!this.listening) return;
    this._restartTimer = setTimeout(() => {
      this._safeStart();
    }, delay);
  }

  _emitState(state) {
    if (this.onStateChange) this.onStateChange(state);
  }

  start() {
    if (!this.recognition) return;
    this.listening = true;
    this._safeStart();
    this.playChime('listen');
    this._emitState(this.wakeWordActive ? 'listening' : 'idle');
  }

  stop() {
    this.listening = false;
    this._clearWakeTimeout();
    this.wakeWordActive = false;
    if (this._restartTimer) clearTimeout(this._restartTimer);
    if (this.recognition && this._isRecognizing) {
      try {
        this.recognition.stop();
      } catch (_) {}
    }
    this._isRecognizing = false;
    this._isStarting = false;
    this._emitState('idle');
  }

  /**
   * Manual activation via mic button tap: opens the 8s active listening window.
   */
  triggerWakeMode() {
    this.wakeWordActive = true;
    this.playChime('wake');
    this._emitState('listening');
    if (this.onWakeWord) this.onWakeWord();
    this._startWakeTimeout(9000);

    if (!this.listening) {
      this.start();
    }
  }

  _startWakeTimeout(ms = 8000) {
    this._clearWakeTimeout();
    this._wakeTimeout = setTimeout(() => {
      this.wakeWordActive = false;
      if (!this.isSpeaking) {
        this._emitState('idle');
      }
    }, ms);
  }

  _clearWakeTimeout() {
    if (this._wakeTimeout) {
      clearTimeout(this._wakeTimeout);
      this._wakeTimeout = null;
    }
  }

  _handleTranscript(transcript) {
    const raw = transcript.toLowerCase().trim();
    if (!raw) return;

    // Suppress recognition while synthesized speech is outputting to avoid audio feedback
    if (this.isSpeaking) return;

    // Wake word patterns: "hey nav", "hi nav", "ok nav", "nav", "navigator".
    // Word-boundary anchors mean this never fires mid-word — "navigate to
    // the water cooler" does NOT trigger it, since "nav" isn't followed by
    // a boundary there. Only a standalone "nav" (or "hey/hi/ok nav") does.
    const wakeRegex = /\b(hey\s*nav|hi\s*nav|ok\s*nav|okay\s*nav|hey\s*navigator|nav|navigator)\b/i;
    const hasWakeWord = wakeRegex.test(raw);

    if (hasWakeWord) {
      this.playChime('wake');
      this.wakeWordActive = true;
      if (this.onWakeWord) this.onWakeWord();

      // Extract anything spoken after the wake word, stripping punctuation:
      const afterWake = raw
        .replace(wakeRegex, '')
        .replace(/^[,\.\?!:;\s-]+|[,\.\?!:;\s-]+$/g, '')
        .trim();

      if (afterWake.length > 1) {
        // Compound utterance (e.g. "Hey Nav, take me to water cooler")
        this._emitState('processing');
        this._clearWakeTimeout();
        this.wakeWordActive = false;
        this._processCommand(afterWake);
        return;
      }

      // Standalone wake word (e.g. "Hey Nav!") -> open active window & acknowledge
      this._emitState('listening');
      this.speak("I'm listening...", { key: 'wake-ack', interrupt: true, cooldownMs: 1000 });
      this._startWakeTimeout(8000);
      return;
    }

    // If wake word window is active, process the user's follow-up command
    if (this.wakeWordActive) {
      this._clearWakeTimeout();
      this.wakeWordActive = false;
      this._emitState('processing');
      this._processCommand(raw);
    }
  }

  _processCommand(text) {
    const cleanText = text.replace(/^[,\.\?!:;\s-]+|[,\.\?!:;\s-]+$/g, '').trim();

    // 1. Stop / Cancel commands
    if (/\b(stop|cancel|end navigation|pause navigation|stop route)\b/.test(cleanText)) {
      this.playChime('stop');
      this.onStop && this.onStop();
      return;
    }

    // 2. Repeat command
    if (/\b(repeat|say again|what did you say|say that again|repeat direction)\b/.test(cleanText)) {
      this.playChime('success');
      this.onRepeat && this.onRepeat();
      return;
    }

    // 3. Status / "Where am I" / "How far" / "locate me"
    if (/\b(where am i|what's my location|current location|how far|what's next|status|where are we|locate me|find me|detect my location)\b/.test(cleanText)) {
      this.playChime('success');
      this.onStatusRequest && this.onStatusRequest();
      return;
    }

    // 3b. Explicit "I'm at X" / "I am near X" / "my location is X" / "set my
    // location to X" — tells the assistant where the user is standing right
    // now, WITHOUT starting navigation. This is what replaces the old fixed
    // starting-point assumption: the user can say this from anywhere.
    const locationSetMatch = cleanText.match(
      /\b(?:i'?m|i am)\s+(?:at|near|by|standing (?:at|near|by))\s+(.+)$|\bmy location is\s+(.+)$|\bset my location to\s+(.+)$/
    );
    if (locationSetMatch) {
      const place = (locationSetMatch[1] || locationSetMatch[2] || locationSetMatch[3] || '').trim();
      if (place) {
        this.playChime('success');
        this.onLocationSet && this.onLocationSet(place);
        return;
      }
    }

    // 3c. "Next" / "skip" / "I'm there" — manually advance to the next leg,
    // for when step-counting isn't firing on this device (see app.js's
    // forceAdvanceLeg for why this exists).
    if (/\b(next step|next leg|skip step|skip|i'?m there|i've arrived|move on|advance)\b/.test(cleanText)) {
      this.playChime('success');
      this.onNextRequested && this.onNextRequested();
      return;
    }

    // 3d. "Calibrate waypoints" — opens the outdoor calibration panel directly.
    if (/\b(calibrate|calibration)\b.*\b(waypoint|point|location)s?\b|calibrate waypoints/.test(cleanText)) {
      this.playChime('success');
      this.onCalibrateRequested && this.onCalibrateRequested();
      return;
    }

    // 3e. "What building is this" — a one-shot camera snapshot sent to a
    // vision-capable model, distinct from the text-only AI query below.
    // Checked first since "what building is this" would otherwise also
    // match if the generic AI pattern were broader.
    if (/\b(what building is this|which building is this|what is this building|identify (?:this|the) building|what'?s this building)\b/.test(cleanText)) {
      this.playChime('success');
      this.onBuildingIdQuery && this.onBuildingIdQuery();
      return;
    }

    // 3f. Open-ended questions answered by the OpenAI layer — "what's
    // ahead", "how's the traffic", "describe the scene". Checked before
    // the generic destination fallback so these don't get misread as a
    // place name.
    if (/\b(what'?s ahead|what is ahead|describe the scene|describe my surroundings|how'?s the traffic|how is the traffic|traffic (?:status|update|level))\b/.test(cleanText)) {
      this.playChime('success');
      this.onAiQuery && this.onAiQuery(cleanText);
      return;
    }

    // 4. Help / commands query
    if (/\b(help|what can i say|commands|options|instructions)\b/.test(cleanText)) {
      this.playChime('success');
      this.onHelpRequest && this.onHelpRequest();
      return;
    }

    // 5. Settings toggle
    if (/\b(open settings|show settings|settings)\b/.test(cleanText)) {
      this.playChime('success');
      this.onSettingsToggle && this.onSettingsToggle(true);
      return;
    }
    if (/\b(close settings|hide settings)\b/.test(cleanText)) {
      this.playChime('success');
      this.onSettingsToggle && this.onSettingsToggle(false);
      return;
    }

    // 6. Navigation / Destination request (carrier phrases stripped)
    const stripped = cleanText
      .replace(/\b(where is|where's|take me to|navigate to|go to|find|i want to go to|guide me to|show me|walk to|please)\b/gi, '')
      .replace(/^[,\.\?!:;\s-]+|[,\.\?!:;\s-]+$/g, '')
      .trim();

    this.playChime('success');
    this.onDestinationRequest && this.onDestinationRequest(stripped || cleanText);
  }

  speak(text, opts = {}) {
    const { key = text, cooldownMs = 1500, interrupt = false, onEnd = null } = opts;
    const now = Date.now();
    const last = this.lastSpokenAt.get(key) || 0;
    if (now - last < cooldownMs) return false;
    this.lastSpokenAt.set(key, now);
    this.lastSpokenText = text;

    if (!this.synth) return false;

    if (interrupt) {
      try {
        this.synth.cancel();
      } catch (_) {}
    }

    try {
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = this.rate;
      utter.pitch = this.pitch;

      // GC Protection: keep reference so Chrome doesn't freeze speech
      window.__activeUtterances.add(utter);

      let safetyTimer = null;

      utter.onstart = () => {
        this.isSpeaking = true;
        this._emitState('speaking');
        // Safety fallback if hardware drops onend
        safetyTimer = setTimeout(() => {
          finalize();
        }, Math.max(text.length * 120, 3000));
      };

      const finalize = () => {
        if (safetyTimer) {
          clearTimeout(safetyTimer);
          safetyTimer = null;
        }
        window.__activeUtterances.delete(utter);
        this.isSpeaking = false;
        if (this.wakeWordActive) {
          this._emitState('listening');
        } else if (this.listening) {
          this._emitState('idle');
        }
      };

      utter.onend = () => {
        finalize();
        if (onEnd) onEnd();
      };

      utter.onerror = () => {
        finalize();
      };

      this.synth.speak(utter);
      return true;
    } catch (err) {
      console.error('SpeechSynthesis error:', err);
      this.isSpeaking = false;
      return false;
    }
  }
}

window.VoiceIO = VoiceIO;
