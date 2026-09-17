/**
 * ai-assistant.js
 * -----------------------------------------------------------------------
 * The "intelligence layer" — takes structured, deterministic context
 * (current location, active route, nearest hazard, traffic level) that
 * the rest of the app already computes, and asks OpenAI to phrase a
 * natural-language answer to open-ended questions like "what's ahead" or
 * "describe the scene". This mirrors the shared document's architecture
 * (computer vision -> structured context -> LLM -> natural language),
 * just calling OpenAI directly from the browser instead of through a
 * separate Python/FastAPI backend, since that backend isn't buildable in
 * the time available.
 *
 * IMPORTANT — the API key never goes in a committed file. It's entered
 * once in Settings and stored in localStorage on that device only. A key
 * pasted into any file that gets pushed to a public GitHub repo is a key
 * anyone can scrape and spend against — this file is written so that
 * can't happen by accident: there is no key constant anywhere here.
 *
 * The deterministic safety engine (hazards.js's priority/zone system,
 * already tuned and tested) still decides on its own whether a warning
 * gets spoken immediately — this layer is for answering direct questions
 * and general scene description, not for time-critical obstacle alerts.
 * A dropped or slow OpenAI call should never delay a hazard warning.
 * -----------------------------------------------------------------------
 */

const OPENAI_MODEL = 'gpt-4o-mini'; // fast + cheap, appropriate for short spoken answers
const OPENAI_VISION_MODEL = 'gpt-4o-mini'; // same model — gpt-4o-mini accepts image input too, no separate model needed
const SYSTEM_PROMPT =
  'You are a calm, concise voice assistant for a blind or low-vision pedestrian. ' +
  'You are given structured sensor data (location, route, detected hazards, traffic) and a spoken question. ' +
  'Answer in 1-2 short sentences suitable for text-to-speech — no lists, no markdown, no filler. ' +
  'Be direct and factual. If the data does not answer the question, say so briefly rather than guessing.';

class AiAssistant {
  constructor({ apiKey = null } = {}) {
    this.apiKey = apiKey;
  }

  setApiKey(key) {
    this.apiKey = key || null;
  }

  hasKey() {
    return !!this.apiKey;
  }

  /**
   * @param {string} question - what the user asked, e.g. "what's ahead"
   * @param {object} context - structured scene data, e.g.
   *   { venue, destination, distanceRemaining, hazard, traffic, position }
   * @returns {Promise<string|null>} spoken-ready answer, or null on failure
   */
  async ask(question, context) {
    if (!this.apiKey) {
      return "I don't have an OpenAI key set up yet. Add one in Settings to enable this.";
    }

    const contextText = this._describeContext(context);
    const body = {
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Current data:\n${contextText}\n\nQuestion: ${question}` },
      ],
      max_tokens: 100,
      temperature: 0.3,
    };

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (res.status === 401) return "That OpenAI key doesn't look valid — check it in Settings.";
      if (res.status === 429) return "OpenAI is rate-limiting these requests right now — try again in a moment.";
      if (!res.ok) return `I couldn't reach OpenAI right now (error ${res.status}).`;

      const data = await res.json();
      const answer = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      return answer ? answer.trim() : "I didn't get a usable answer back from OpenAI.";
    } catch (err) {
      console.warn('OpenAI request failed:', err);
      return "I couldn't reach OpenAI — check your internet connection.";
    }
  }

  /**
   * Sends a single camera frame (as a base64 data URL) along with the
   * user's spoken question to a vision-capable model, asking it to
   * identify the building/place in view. Deliberately NOT a continuous
   * live-recognition system — this is one-shot, asked explicitly, and
   * the model is instructed to say plainly when it can't tell rather
   * than confidently guess. This genuinely works when a name board or
   * sign is visible in frame (reading text in an image is a
   * well-solved problem for these models) and genuinely does NOT work
   * from raw architectural appearance alone with no legible signage —
   * that's the same visual-recognition problem tested twice earlier
   * this project and found unreliable, and a vision-language model
   * guessing from architecture alone would have the same failure mode,
   * just hidden behind more confident-sounding phrasing. The prompt
   * below is written specifically to prevent that: it must refuse to
   * name a building unless it can actually read identifying text.
   */
  async askAboutImage(imageDataUrl) {
    if (!this.apiKey) {
      return "I don't have an OpenAI key set up yet. Add one in Settings to enable this.";
    }

    const body = {
      model: OPENAI_VISION_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are helping a blind or low-vision pedestrian identify a building from a single photo. ' +
            'Only name the building if you can actually read a visible sign, nameplate, or lettering in ' +
            'the image that identifies it — never guess a building\'s identity from its architecture, ' +
            'shape, or general appearance alone, since that is not reliable. If you can read identifying ' +
            'text, state the name you read and quote it. If you cannot read any identifying text, say ' +
            'plainly that you can\'t identify the building from this photo, and briefly describe what IS ' +
            'visible (e.g. "a multi-story building with a covered walkway") instead of guessing a name. ' +
            'Answer in 1-2 short sentences suitable for text-to-speech — no lists, no markdown.',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What building is this? Only tell me if you can read a sign or label — otherwise say so.' },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        },
      ],
      max_tokens: 120,
      temperature: 0.2,
    };

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (res.status === 401) return "That OpenAI key doesn't look valid — check it in Settings.";
      if (res.status === 429) return "OpenAI is rate-limiting these requests right now — try again in a moment.";
      if (!res.ok) return `I couldn't reach OpenAI right now (error ${res.status}).`;

      const data = await res.json();
      const answer = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      return answer ? answer.trim() : "I didn't get a usable answer back from OpenAI.";
    } catch (err) {
      console.warn('OpenAI vision request failed:', err);
      return "I couldn't reach OpenAI — check your internet connection.";
    }
  }

  _describeContext(context) {
    const lines = [];
    if (context.venue) lines.push(`Venue: ${context.venue}`);
    if (context.position) lines.push(`Position: lat ${context.position.lat.toFixed(6)}, lon ${context.position.lon.toFixed(6)} (accuracy ~${Math.round(context.position.accuracy || 0)}m)`);
    if (context.destination) lines.push(`Destination: ${context.destination}`);
    if (context.distanceRemaining !== undefined && context.distanceRemaining !== null) {
      lines.push(`Distance remaining: ${Math.round(context.distanceRemaining)} meters`);
    }
    if (context.hazard) {
      lines.push(`Nearest detected object: ${context.hazard.label}, zone: ${context.hazard.zone}` +
        (context.hazard.guidance ? `, suggested action: ${context.hazard.guidance}` : ''));
    } else {
      lines.push('Nearest detected object: none currently in view');
    }
    if (context.traffic) {
      const c = context.traffic.counts || {};
      const parts = Object.entries(c).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}${n > 1 ? 's' : ''}`);
      lines.push(`Traffic level: ${context.traffic.level}` + (parts.length ? ` (${parts.join(', ')} visible)` : ' (no vehicles currently visible)'));
    }
    return lines.join('\n') || 'No context available.';
  }
}

window.AiAssistant = AiAssistant;
