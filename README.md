# Voice-guided indoor navigation + hazard warnings — multi-venue

Covers **two floors** — the SJT 7th floor corner and the H Block 3rd floor
dormitory wing — through one voice-first assistant with a "Hey Nav" wake
word, a slide-out settings sidebar, live obstacle warnings, and an
AR-style ground path overlay. Built to match the design decisions already
in `visionassist-ai` (on-device only, no cloud, Dijkstra routing,
pedestrian dead reckoning), so it can be merged in as new venues later.

## Voice commands (wake word: "Hey Nav")

Say "Hey Nav" then any of:
- **"take me to [place]"** / **"where is [place]"** — routes you there
- **"I'm at [place]"** / **"my location is [place]"** — tells the assistant
  where you're standing right now, without starting navigation (see
  "Where are you starting from?" below — this is the important one)
- **"repeat"** — replays the current turn instruction
- **"where am I"** — re-checks your location, or reports nav progress if
  you're mid-route
- **"switch floor"** — cycles between SJT and H Block
- **"stop"** — cancels the current route
- **"help"** — spoken list of commands

A bare **"nav"** or **"navigator"** also works as a shorter wake word. The
wake-word regex is anchored so it never fires mid-word — "navigate to the
lift" does not accidentally trigger it twice.

## Where are you starting from? (the bug you reported, actually fixed)

The earlier version assumed every route started from a fixed default node
(e.g. always the stairwell), which is exactly what caused "3 meters from
the lift showing as 0 meters" — the app wasn't wrong about the distance
along the route, it was wrong about where the route started.

That assumption is gone. `state.currentNodeId` is now `null` until you
confirm it, by voice or by tapping a place in the sidebar. Ask for a
destination before confirming your location, and the assistant asks
"where are you right now?" first, then resumes your original request once
you answer — it never silently guesses.

**I did try to make this fully automatic first, and backed off on purpose.**
I built a visual place-recognition system (`js/localization.js`) that
matches the live camera feed against reference photos of each landmark,
and tested it against your actual dataset before shipping it. The result:
in this building, two *different* landmarks (e.g. the lift and a plain
corridor turn) can look more similar to each other (0.99 match) than two
photos of the *same* landmark do to each other (0.93–0.96) — the uniform
walls and lighting defeat simple visual matching. Shipping that as a
confident auto-detect would have just moved your bug somewhere sneakier.

So the vision system is used as a **hint, not an answer**: when it's
confident, it suggests a place first ("it looks like you might be near the
lift — say yes or tell me your real location"), but a human always
confirms. It also runs in the background the whole time you're using the
app to power the landmark bubble below.

## The "you're near X" bubble

Per the request that identifying *any* recognized place — not just your
destination — should surface something on screen: the same visual matcher
runs continuously (every 2.5s) while the assistant is active indoors. When
it recognizes a landmark with a confident, clearly-separated match, a
small blue bubble appears near the top of the screen ("You might be near:
the water cooler") and it's announced once by voice. Given the matching
limitations above, treat this as a friendly hint, not a guarantee — it's
intentionally worded "might be," and it stays silent rather than guess
when the vision signal is ambiguous, which is often in this building.
This is indoor-only; outdoors, GPS answers "where am I" directly, so no
visual matching is needed or run.

## AR ground path

The camera overlay draws a tapered path low in the frame, with chevrons
flowing along it, instead of a floating rotating arrow badge. Outdoors,
where a route has multiple points, the path now genuinely **curves
through a short lookahead** (up to 4 upcoming route points, each
projected independently by its own bearing/distance from your current
position) rather than only ever leaning in one direction — a real winding
footpath renders as a real S-curve, not a single left/right tilt. I
verified this with rendered test images (a deliberate S-curve input
produces a visible S-curve output) and a full simulated walk through a
6-point route, checking that the lookahead shrinks gracefully as the
route nears its end. Indoors, and for the very last stretch of any route,
it gracefully falls back to the original single-point shape — same
rendering code path either way. Beyond about 70° off on the nearest point
— meaning it's essentially behind you — it switches to a clear "turn
around" loop icon instead of stretching the path into something
confusing. This is still a heading-based illusion (uses the phone's
compass), not true floor-locked AR — see the comment at the top of
`js/ar.js` for why real plane-tracked AR (WebXR) was deliberately not
used: it only works on ARCore Android phones in Chrome, not iPhones. Full
camera-based automatic place recognition (point the camera at a building
and have it recognize which one, with no GPS) was requested but isn't
buildable here — see "Why the camera can't 'just recognize' a block"
below for the honest reasoning; the GPS system above already delivers the
same practical outcome (the arrow updates and points correctly
automatically as you walk) without needing that.

**Real-device finding**: on-device screenshots at SJT showed the path
never rendering at all — not misdirected, just never appearing. The
"you're near X" bubble (also canvas-drawn) DID appear, proving the canvas
pipeline itself was fine; the actual bug was that the arrow-drawing code
refused to draw anything unless it had a valid compass reading, and this
phone's compass apparently never delivered one — plausibly because
concrete-and-rebar buildings are notorious for scrambling magnetometers.
Fixed: `ArOverlay` now falls back to "assume you're already facing the
target" (a straight-ahead arrow) whenever no live compass reading has
arrived, with a small on-screen note ("No compass signal — showing
straight-ahead") so it's clear when this fallback is active. It
transparently upgrades to true compass-relative rendering the moment a
real reading does show up.

## Why the camera can't "just recognize" a block

A request came in for the camera to automatically recognize its
surroundings from a walkthrough video and point to the right block, with
no GPS involved. Worth explaining clearly why that's not in this build:
"training" real visual place recognition means gradient descent over
thousands of labeled images on GPU hardware — production systems like
Google Live View are trained on millions of geotagged street-level
photos. Neither the training infrastructure nor that scale of data exists
here. I checked the actual walkthrough video for embedded GPS metadata
first (there was none — WhatsApp strips it), and it's also filmed at
night, which is close to the hardest lighting condition for any
lightweight visual matching. The indoor color-fingerprint hint elsewhere
in this app (see "Where are you starting from?") was already shown to be
unreliable on easier daytime scenes — a harder night outdoor version
wouldn't be more reliable. The GPS-driven system above delivers the
actual behavior that was being asked for (the arrow automatically finds
and points to the right block as you walk, no manual input) — it just
does it via GPS instead of a camera recognizing the scene.

## Two sensor-dependent features can silently fail — here's the safety net

The same device testing surfaced a second, related issue: all five
screenshots taken while walking through clearly different physical spots
showed the *identical* turn instruction and distance. That means
step-counting (`onDeviceMotion` in `js/app.js`) never advanced the route
past the first leg — most likely the same root cause as the compass issue
(this phone/browser not delivering `devicemotion` events at all indoors).

Rather than keep guessing at exactly why a given phone's sensors go quiet,
the app now has an explicit escape hatch: a **"Next" button** next to
Repeat/End Route, and the voice command **"hey nav next"** (also "skip",
"I'm there", "I've arrived"), which manually advances to the next leg the
same way reaching the distance threshold normally would. Asking "where am
I" while navigating now also reports whether footsteps or a compass signal
have been detected recently, so you don't have to infer sensor health from
symptoms the way this round of testing had to.

## Outdoor navigation (GPS) — real routes from an open routing service

The outdoor venue ("Outdoor — Hostel Paths," covering all six directions
between Ladies Hostel G/H/J) no longer routes from a hand-built graph.
GPS answers "where am I" directly (no confirmation prompt needed the way
indoor requires — see `js/gps-nav.js`'s `GpsTracker`), and the actual walk
to any destination — the three hostels by name, or literally anywhere
else — is fetched live from an open routing service via
`js/route-provider.js`. This is what "all kinds of paths possible" means
in practice: it's not limited to a fixed set of pre-mapped waypoints.

**How a destination resolves**: say a hostel name (`"hostel g"` etc.) and
it uses that node's coordinate if calibrated, or falls back to geocoding
the name via Nominatim (OpenStreetMap's geocoder) if not. Say anything
else — any place name — and it geocodes directly. Either way, once a
destination coordinate exists, a real walking route is fetched between
your current GPS position and it.

**Two honest caveats that come with using real map data, not invented
coordinates:**

1. **OSRM's free demo server's foot-routing support is genuinely
   disputed.** Official docs say it serves car+foot+bike; independent
   developer reports (OpenStreetMap's own help forum, GitHub issues) say
   it silently returns driving-style routes for foot requests. This app
   defaults to OSRM because it needs zero setup — verify early that routes
   and times look like walking, not driving. If not, switch
   `DEFAULT_PROVIDER` in `js/route-provider.js` to `'ors'` and get a free
   OpenRouteService API key (openrouteservice.org/sign-up), which has an
   unambiguous dedicated walking profile.
2. **Your specific campus paths are very likely not in OpenStreetMap
   yet.** Internal campus footpaths are one of the most common OSM
   coverage gaps — public roads get mapped, internal walkways often
   don't. If they're not mapped, any router (this, Google, anything) will
   route along the nearest mapped road instead of the real path, which
   matters for a mobility aid. `checkRouteSanity()` in
   `route-provider.js` compares the route distance to the straight-line
   distance and warns by voice if a route looks suspiciously indirect —
   it catches obviously-wrong routes, not every case. **The real fix**:
   add the paths yourself at openstreetmap.org (free account, iD editor,
   trace the paths you actually walk) — after that, any OSM-based router
   routes through them correctly, immediately, everywhere.

**Once a route is fetched, tracking is GPS-driven, not step-counted.**
Bearing and remaining distance are recomputed from your actual live
position against the route's polyline on every GPS update, so there's no
accumulating drift and nothing to get permanently stuck the way indoor
step-counting could (see above) — arrival is real proximity, scaled to
the phone's reported GPS accuracy. The AR ground path reuses the exact
same rendering code as indoor; only the position/bearing source changes.

**Calibration is now optional**, not required to unlock routing (Settings
→ Outdoor Calibration, or say "hey nav calibrate waypoints"). Capturing a
hostel's real entrance coordinate — stand there, tap **Capture here**, it
averages 5 GPS readings — just makes that specific endpoint exact, since a
geocoded building coordinate from OSM is often just a centroid, not the
actual entrance. Tap **Export calibration** and paste the result into
`CALIBRATED_COORDS` in `js/venues/outdoor-hostels.js` to make it permanent.

I verified the full loop end-to-end with mocked API responses matching
documented formats: request a route → parse a realistic OSRM response →
feed in sequential GPS fixes approximating an actual walk → correct
bearing/distance at each polyline point → correct arrival. Also verified
separately: the geocoding fallback for uncalibrated destinations, and the
sanity-check warning firing on a deliberately indirect mock route. The
haversine distance and bearing formulas were checked against independent
references (cardinal-direction test cases, and the well-documented
~344km London-to-Paris distance) before being trusted for any of this.

## AI voice assistant (OpenAI) — open-ended questions

New voice commands — "what's ahead", "how's the traffic", "describe the
scene" — are answered by OpenAI (`js/ai-assistant.js`), given the exact
same structured, deterministic data the rest of the app already computes
(current location, active route, nearest detected hazard, traffic level).
This mirrors the shared planning document's architecture (computer vision
→ structured context → LLM → natural language), calling OpenAI directly
from the browser instead of through a separate Python/FastAPI backend.

**The API key is never committed anywhere.** Enter it once in Settings →
AI Voice Assistant; it's stored in that browser's `localStorage` only. If
you ever see a key in a source file or a git commit, treat it as
compromised and rotate it immediately — that should never happen with
this setup, but it's worth knowing what "wrong" looks like.

**The deterministic hazard system still runs independently and always
wins.** OpenAI answers direct questions; it does not gate or delay
critical obstacle warnings, which come from the existing zone/priority
system in `hazards.js` regardless of whether an API key is even set.

I tested the request/response handling against realistic mocked responses
matching OpenAI's documented API format — successful answers, an invalid
key (401), rate limiting (429), and network failure all produce a clear
spoken message rather than a silent failure or hang.

## Traffic detection

`hazards.js` now also recognizes car, motorcycle, bus, bicycle, and truck
— the same COCO-SSD model already loaded for indoor obstacle detection,
just with vehicle classes turned on. A rolling average over the last 5
detection ticks smooths this into a LOW/MEDIUM/HIGH traffic level, which
feeds both the "how's the traffic" voice answer and, for a vehicle at
close range, an ordinary critical-zone hazard warning like any other
obstacle. This is a simple visible-in-frame count, not a calibrated
traffic-engineering metric — it answers "does it look busy right now,"
which is what a pedestrian actually needs.

## Outlining AR — visual bounding boxes for detected hazards

Detected people, vehicles, and obstacles now get a real-time outline
drawn directly on the camera feed — not just a voice announcement — color
coded by urgency (red = critical/close, amber = near, green = further
away), with a label chip naming what was detected. This is what the AR
literature calls "Outlining AR": drawing a virtual outline aligned to a
real detected object's position, the same category used in automotive
obstacle-marking systems.

This uses the exact bounding boxes COCO-SSD already computes for hazard
detection (`hazards.js`'s `onDetections` callback) — no new detection
work, just finally rendering data that existed already. The one non-
trivial part was correctly mapping the detector's native video-pixel
coordinates onto the canvas: the camera feed is displayed with CSS
`object-fit: cover`, meaning it's scaled up and center-cropped to fill
the screen rather than shown at its native resolution, so a naive 1:1
coordinate mapping would misplace every box. I verified the mapping
directly (a point at the exact center of the video correctly lands at
the exact center of the canvas) and end-to-end in a real running browser
via Playwright (fed fake detections, confirmed the boxes render in the
right place with no console errors) before considering this done.

**Real-device finding**: shipped this, then got a report of "I cannot see
any outlines" — and the synthetic Playwright test above, while it proved
the rendering *math* was correct, hadn't caught a real layering bug:
`#ar-canvas` had no explicit `z-index`, while the top bar and voice-hub
control bar both have `z-index: 20`. Any hazard outline positioned in the
bottom third of the frame — exactly where a close, critical-zone
detection's bounding box naturally extends, since a nearby object fills
more of the frame — was being silently painted *underneath* the opaque
voice-hub bar. Fixed by giving `#ar-canvas` a higher `z-index` (25, still
safely below the settings sidebar at 90/100); `pointer-events: none` on
the canvas means this doesn't block taps on the buttons underneath it.
Reproduced the exact failure with a synthetic box extending into that
region, confirmed it was invisible before the fix and fully visible
after, in an actual rendered screenshot both times.

Also added a small on-screen diagnostic (bottom-left, green monospace —
developer-visible, not meant to be pretty) showing whether the hazard
model loaded successfully and how many objects it's currently seeing, so
future "I can't see X" reports are diagnosable from a screenshot instead
of requiring another guess-and-check round. It also caught, live in this
sandbox, a genuine model-load failure (cdnjs blocked here) and confirmed
the app degrades gracefully — voice navigation keeps working, with a
clear spoken notice that hazard warnings won't be available that session,
rather than crashing or failing silently.

## Why Location-based AR, not image-recognition AR

Prompted by reference material on AR types, worth stating plainly why
this app is built the way it is: it's **Location-based AR** (GPS +
compass + accelerometer driving the overlay), not Markerless/image-
recognition AR (camera visually recognizing *where* it is) and not Marker
AR (removed — see "QR" history in the codebase). This isn't an arbitrary
choice — it's what actually held up under testing. Two independent rounds
of testing image-based place recognition against this project's real
photos and video (documented above and in `localization.js`) found it
unreliable enough to actively mislead rather than help. Location-based AR
doesn't have that failure mode: GPS either has a fix or it doesn't, and
never confidently reports the wrong building. The one thing image
recognition *is* reliably good for here — detecting an object's presence
and rough position, not recognizing which place this is — is exactly what
the hazard detection and Outlining AR above already do.

## Venues included

| Venue | Destinations it knows |
|---|---|
| **SJT — 7th floor corner** | staircase, entrance lobby, rooms 711/712, faculty cabins, water cooler, women's washroom (714), room 715, open corridor, far end of corridor |
| **H Block — 3rd floor** | lift, staircase, water cooler, washroom, main corridor / walking area, storage room, common room (sofa), corridor turn, dormitory rooms, balcony (drying area) |
| **Outdoor — Hostel Paths** | Ladies Hostel G/H/J plus specific real entrances (G/J main entrances, J's lift/side entrance, the shared mess entrance), the main gate, both convenience stores, the guest house, and bicycle parking — from real hand-sketched maps of the area, not a generic guess. Plus literally any other place name via live geocoding + real routing. See "Outdoor navigation" above. |

Indoor venues' data live in `js/venues/*.js` in the same format, so adding
a fourth floor later is just a new file plus one `registerVenue()` call.
The raw photos and walkthrough videos for the two indoor venues are kept
in `dataset/` for reference and for re-deriving the map (or the visual
fingerprints — see `scripts/precompute_fingerprints.py`) if you
recalibrate.

## What's new for H Block specifically

- **Sofa detection**: COCO-SSD's `couch` class is now spoken as "sofa" in
  hazard warnings (was labelled "couch" before) — the H Block common room
  has one squarely in the walking path in the video.
- **Lift** is a first-class destination (`"where is the lift"`, `"take me
  to the elevator"`), separate from the staircase.
- **Balcony / drying area**, **storage room**, and **common room** are
  destinations with `isDoor: true`, so the app calls out a door check
  before arrival, same as it does for washrooms and dormitory room doors.
- The dormitory doors themselves are one grouped destination
  (`dormitory_rooms`) rather than individual numbered rooms — none of the
  room number plates were clearly legible in the photos. If you can read
  the actual numbers off the doors, split this into per-room nodes the
  same way SJT has `room_715` as its own node.

## PWA manifest quality (PWABuilder scan)

Running the hosted URL through pwabuilder.com surfaces "Action Items" —
mostly optional metadata. What's actually addressed:

- **Real screenshots** (`screenshots/`) generated from the running app via
  Playwright — idle screen, listening state, the settings sidebar, and an
  active route with the AR ground path + landmark bubble — and referenced
  in `manifest.json`'s `screenshots` array.
- **`id`**, **`categories`**, **`lang`**, **`dir`**, and
  **`prefer_related_applications`** added to the manifest.

Left alone, on purpose: `related_applications` (no native app exists),
IARC rating (a content-age rating doesn't meaningfully apply to a
navigation utility), and the various "enhancement" items (`share_target`,
`file_handlers`, `protocol_handlers`, `widgets`, `edge_side_panel`,
`windows-control-overlay`, `tabbed`, notes-app registration, background
sync, push notifications) — none of them fit what this app actually does,
and adding manifest fields with no real behavior behind them just adds
surface area to maintain.

## Run it

Needs HTTPS (or `localhost`) for camera/mic/motion permissions:

```
cd sjt7-navassist
python3 -m http.server 8443   # or any static server; use ngrok/GitHub Pages for a real phone test over HTTPS
```

Open on a phone in Chrome (Android) or Safari (iOS), tap **Start assistant**,
grant camera / microphone / motion permissions, then either say a place
("take me to the water cooler", "where is room 715", "faculty cabin") or
tap it from **Show destination list**.

## What's real vs. what's a placeholder

| Feature | Status |
|---|---|
| Voice destination recognition (Web Speech API + synonym matching, "Hey Nav" wake word) | Working |
| Shortest-path routing (Dijkstra) + turn-by-turn instructions | Working |
| Location check-in ("I'm at the lift") replacing the fixed-start assumption | Working |
| Ambient visual place matching (indoor soft hint + bubble) | Working, but low-confidence by design — see "Where are you starting from?" above for why it's deliberately conservative |
| AR ground-path overlay, curves toward turns | Working, with a straight-ahead fallback confirmed necessary on real hardware — see "AR ground path" above |
| Manual "Next" advance (voice or button) as a step-counting safety net | Working — added after real-device testing showed step-counting can silently never fire |
| Outlining AR hazard boxes actually visible on real devices | Fixed a z-index layering bug — see "Outlining AR" above |
| Outdoor GPS navigation, any destination via live routing | Working — see "Outdoor navigation" above for the two honest caveats (disputed OSRM foot-routing reliability, possibly-unmapped campus paths) |
| Step-counted progress along a route (dead reckoning) | Working, adjustable stride length in Settings |
| Person / chair / table / sofa hazard warnings with left-right correction | Working (TensorFlow.js COCO-SSD) |
| Vehicle detection + traffic level (LOW/MEDIUM/HIGH) | Working — see "Traffic detection" above |
| OpenAI voice assistant ("what's ahead", "how's the traffic", "describe the scene") | Working once you add an API key in Settings — see "AI voice assistant" above |
| "Steps ahead" detection | **Heuristic placeholder** — edge-density guess, will false-positive on plain tile floors. Swap in a real geometric detector for production use. |
| "Door closed / open" | **Not vision-detected** — the app announces "there's a door here" from the map data (`isDoor` flag) since COCO-SSD has no door class. |

## Indoor calibration (do this once, on each real floor)

Each indoor venue file in `js/venues/` was authored by inspecting photos
and video, not surveyed — the room layout and connections are right, but
distances and exact bearings are estimates. (Outdoor calibration is a
different, optional process — see "Outdoor navigation" above.) To calibrate:

1. Walk each edge in that venue's `EDGES` array and update `distance_m`
   with the actual paced or taped distance.
2. If a turn direction ever sounds wrong to a test user, nudge the `(x, y)`
   coordinates of the node it turns *toward* — bearings are computed
   automatically from coordinates, so you never edit bearings by hand.
3. Tune stride length live in Settings → Walking Calibration, or the
   accelerometer `THRESHOLD` / `MIN_GAP_MS` in `js/app.js`'s
   `onDeviceMotion()`, against the actual tester's gait.
4. **SJT**: I placed **room 715 next to 714** based on typical even/odd
   room-number pairing — I only saw signage for 714 (women's washroom) in
   the photos. Please confirm 715's real position.
5. **H Block**: I clustered the lift, staircase, water cooler and washroom
   together at one landing based on the video, and treated the dormitory
   doors as one group rather than individual rooms. Confirm both against
   the real floor before relying on it.
6. **Visual fingerprints**: to add or improve landmark recognition
   accuracy, add more reference photos to `dataset/<venue>/`, list them in
   `scripts/precompute_fingerprints.py`'s `REFERENCES` dict, and re-run
   `python3 scripts/precompute_fingerprints.py`. More photos per landmark,
   taken from different distances/angles, directly improves match quality.

## Known lessons carried over from `build-status.md`

Your build-status doc listed four defects testing caught in the original
app. Two directly apply to voice/hazard code and are already handled here:

- **Repeating hazard too fast** (was every 0.9s) → every spoken warning in
  `voice.speak()` has a cooldown key + minimum interval (2.5–6s depending on
  urgency), in `js/app.js`'s `handleHazard()`.
- **Steering advice not marked as spoken, so it repeated** → hazard and
  turn messages are always built as one combined string before being
  passed to `speak()`, never spoken in separate pieces.

## Suggested next steps

1. Get me (or drop into your own editor) the actual `visionassist-ai`
   source so this can become a new venue module inside it, reusing your
   real `structure.js` and decision engine instead of the placeholders
   above.
2. Run the user study your build-status doc already flagged as the
   biggest gap — phrasing, alert timing, and turn instructions need real
   blind or low-vision testers on this specific floor, not just automated
   checks. This matters even more now with the location check-in flow —
   test whether "say I'm at the lift" is actually the easiest way for a
   real user to confirm their position, or whether something like a
   distinctive floor marker + a simpler yes/no confirmation would work
   better in practice.
3. If you can get more/better reference photos per landmark (see
   Calibration item 6), the visual hint and bubble will improve — but
   given what the current dataset shows, don't expect it to become fully
   reliable through photos alone in a building this visually uniform;
   budget for the voice/tap confirmation staying the primary mechanism.

## Turning this into an .apk you can send over WhatsApp

I can't build the `.apk` file myself in this environment — packaging a real
Android app needs the Android SDK and Google's Maven repository, and both
are network-blocked in this sandbox. Here are two ways to get an actual
`.apk`, both realistic without installing Android Studio:

### Option A — fastest: PWABuilder (no coding, ~5 minutes)

This app is now a proper installable PWA (manifest + icons + service worker
added). [PWABuilder](https://www.pwabuilder.com) is Microsoft's free tool
that turns any hosted PWA into a signed, installable `.apk`/`.aab`.

1. Host this folder somewhere with HTTPS. Easiest: create a GitHub repo,
   upload this folder, then turn on **Settings → Pages** — this is the same
   plan already in `build-status.md`. You'll get a URL like
   `https://yourname.github.io/sjt7-navassist/`.
2. Go to pwabuilder.com, paste that URL, click **Start**.
3. Click the **Android** package option → **Generate**.
4. Download the `.apk` it produces.
5. Send that `.apk` file over WhatsApp like any other file. The recipient
   taps it, allows "install from unknown sources" once, and it installs
   like a normal app — full-screen, with its own icon, camera/mic/motion
   permissions requested the first time it runs.

No signing keys or Play Store account needed for this — PWABuilder signs it
for you (fine for sharing directly; you'd only need your own signing key
for a Play Store listing).

### Option B — if you have Android Studio on your own machine

Google's own `bubblewrap` CLI does the same thing as PWABuilder, from your
terminal, once the folder above is hosted at an HTTPS URL:

```
npm install -g @bubblewrap/cli
bubblewrap init --manifest https://yourname.github.io/sjt7-navassist/manifest.json
bubblewrap build
```

This produces `app-release-signed.apk` in the project folder it creates —
send that over WhatsApp the same way.

### Why not skip the APK entirely?

Since this is already a PWA, sending people the *link* (once hosted) and
having them tap **Add to Home Screen** in Chrome gets them a home-screen
icon, offline support, and full permissions — functionally identical to an
installed app, with no APK, no "unknown sources" warning, and no
re-packaging every time you edit the code. The APK route above is worth it
if you specifically want a file to send, or want it to eventually reach the
Play Store.

## Obstacle detection, people, and voice (works without an API key)

The camera runs COCO-SSD at ~4 fps. Everything below is computed on the phone.

- **People and objects.** People, chairs, tables, sofas, benches and vehicles trigger spoken warnings. Other objects (bags, bottles, laptops, TVs, plants, …) are only described when asked.
- **Closing in.** Each object is tracked between frames; a box that keeps growing is reported as "getting closer" (people and vehicles only).
- **Where it is.** Alerts say left / ahead / right, e.g. "Person getting closer from your left. Move slightly right."
- **Other channels.** Vibration (Android Chrome) scales with urgency; with earphones a short beep is panned to the side the hazard is on. Both can be switched off in Settings.
- **AR overlay.** Boxes carry a distance chip (`person ↑ · ~2.5 m`). Distances are rough zones from box height, not measurements.

Voice commands (say "Hey Nav" first):

| Say | Answer |
|---|---|
| "What is in front of me" / "What do you see" / "What's ahead" | Summary of what is in view, nearest first |
| "Is there any obstacle" / "Is the path clear" | Whether anything is blocking the way |
| "How many people are near me" / "Is anyone nearby" | People count, side and distance |
| "How's the traffic" | Vehicle count and level |

If an OpenAI key is set, "what's ahead" and "describe the scene" use it (and are given the detected objects); otherwise the on-device answer is used.

Tests: `node test/detection-tests.js` (logic, no browser) and `node test/e2e-detection.js` (headless Chromium; needs Playwright and the app served at `APP_URL`, default `http://localhost:8765/`; it replaces the COCO-SSD CDN script with a scripted stub).
