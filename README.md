# Earth Learner

A fast, local, canvas-rendered 3D-looking globe for learning world geography.

- **Explore** (Phase 1): spin, zoom, hover and click countries.
- **Learn**: spaced-repetition questions, introduced outward from your home country and scheduled with
  FSRS. Progress is stored locally in IndexedDB. Three learn layers:
  - **Countries**: the 197 sovereign states. "Find it" (click the country) and "Name it" (type the
    highlighted country's name).
  - **Capital cities**: one per country. Find it, Name it (a pulsing marker), and an optional
    "Capital of …?".
  - **Cities**: major (and optionally extended) non-capital cities. Find it and Name it.
  City Find questions use either a **blank map**, where a click within `locateRadiusKm` (default 50 km)
  is correct, or **all city dots without names**, where you click the right dot (clicks that miss every
  dot are ignored). A session mixes all enabled layers, or one via "Study" on the Learn start screen.

## Run

Requires Node 20+.

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build to dist/
npm run preview    # serve dist/
npm run test       # vitest unit tests
npm run build:data # regenerate public/data from Natural Earth (add --refresh to re-download)
```

Append `?seed=demo` to the URL to load a fake progress history into a separate demo database.
Your real progress is never touched.

Controls: drag to rotate (with inertia), wheel / trackpad pinch / two-finger pinch to zoom toward the cursor,
click to select, double-click to fly to a country. Keys: arrows rotate, `+`/`-` zoom, `H` home,
`L` toggle labels, `D` debug HUD. In Learn mode, on the reveal screen, `1`–`4` choose a grade and
`Enter`/`Space` accept it. Shortcuts are ignored while typing an answer.

## Data

`scripts/build-data.mjs` downloads Natural Earth Admin 0 – Countries (110m and 50m GeoJSON from
`nvkelso/natural-earth-vector`, public domain), caches them in `scripts/.cache/`, and writes:

| File | Contents |
| --- | --- |
| `public/data/countries-110m.topo.json` | Low detail, used while moving. 110m lacks 65 small countries, so their 50m geometry is merged in, giving every country at both levels. |
| `public/data/countries-50m.topo.json` | High detail, used when idle and for hit-testing. |
| `public/data/countries-meta.json` | One record per country: names, type, continent/region, label point, label rank, colour, population, land neighbours (`topojson.neighbors` on 50m), `geoBounds` bbox, bounding cap, spherical area. |

| `public/data/quiz-data.json` | Quiz scopes (`sovereign`: 193 UN members + Vatican, Palestine, Taiwan, Kosovo), scoring merges, and display name + accepted answers per country. |
| `public/data/cities.json` | NE 10m populated places in quiz countries with population ≥ 100,000, plus every capital and each country's largest place (3,113 cities), with accepted names and the curated capitals. Short keys: `i` id, `n` name, `c` country, `p` population, `r` NE SCALERANK, `a` extra names. |
| `public/data/country-distances.json` | Border-to-border great-circle distance (km) between every pair of features, on the 110m-with-additions geometry. Neighbours and enclaves are 0. Stored as the upper triangle in sorted-ID order. |

Hand-maintained sources live in `data-src/`:
- `scope-sovereign.json`: the quiz items. The build fails unless each maps to exactly one feature.
- `scoring-merges.json`: non-items that count as their parent when clicked (Somaliland → Somalia, …).
- `country-aliases.json`: display names and alternative answers.
- `capitals.json`: one capital per country (`city` ID), `alsoAccept` answers for "Capital of", a `note`,
  and `flagged` for multiple, disputed or ambiguous capitals.
- `city-aliases.json`: exonyms, native and old names per city. `reject` drops wrong or garbled NE
  names; `display` overrides the shown name.
- `extra-cities.json`: places NE lacks (Yaren, Nauru).

City tiers (capital / major / extended) are computed at runtime by `src/layers/city/tiers.ts` from
settings and the home country; the build script imports the same file for its stats.

Natural Earth label points that fall outside their country (e.g. New Zealand's) are replaced by the
pole of inaccessibility of the largest polygon (`polylabel`).

The country ID is `ADM0_A3` (`ISO_A3` is `-99` for France, Norway, …). `MAPCOLOR7` is checked against the
neighbour graph and corrected where neighbours clash (`colorIndex`). The generated files are checked in, so
the app runs without re-running the script.

## Learn layers

Everything specific to a kind of feature lives behind `LearnLayer` (`src/learn/layer.ts`). The queue,
scheduler, controller and storage are layer-agnostic. A new layer (rivers, lakes…) provides:

| Member | Purpose |
| --- | --- |
| `id`, `name`, `noun`, `directions` | Identity; every direction it can ask (`locate`, `name`, extras like `capitalOf`). |
| `displayName`, `countryOf`, `enabled(settings)` | Names for prompts; owning country; whether it is turned on. |
| `queueConfig(ctx)` | Items in introduction order, active directions per item (first = introduced first), `eligibleNew` prerequisites (may read other layers' cards), per-layer limits. |
| `grading(direction, settings)` | Time thresholds and typo tolerance. |
| `question(item, direction, settings)` | Prompt text, chip, and whether the answer is a click or typed. |
| `evaluateClick` / `evaluateTyped` | Correctness, typo, optional grade cap, what was clicked or matched, km off. |
| `revealDetail` | Text explaining the answer. |
| `presentQuestion` / `presentReveal` / `clearPresentation` | Globe effects: camera, highlights, pulse markers (`MapMarkers`), dot visibility. |

Explore rendering is a Phase 1 render `Layer` registered with `globe.addLayer`. It can contribute labels
to the shared collision-avoiding placement with `globe.addLabelProvider`. Point features return
`distancePx` from `hitTest`, so dots and small-country markers compete by distance and beat areas.

Card keys are `${layerId}:${itemId}:${direction}`; every direction of the same item is a sibling for burying.

## Learning model

- A **card** is `(layer, item, direction)`. A card with no stored state is new.
- **FSRS** via `ts-fsrs`, wrapped in `src/srs/scheduler.ts` (nothing else imports it).
- **Limits are per layer**: new per day, max reviews per day, pause-new threshold. New cards from different
  layers are interleaved.
- **New countries:** up to `newPerDay` per day, in order of distance from home (ties by LABELRANK).
- **New cities** become eligible once their country's Find card has graduated to Review (or, if the
  country layer isn't asking Find questions, once the country has been introduced). Order: capitals,
  then major, then extended; within a tier by distance from the home country's border, then population.
  In `both` mode the locate card comes first and the name card the next day. Next-day siblings share
  the same daily allowance. New cards pause while more than `pauseNewIfDueAbove` reviews are due.
- **Session queue** (`src/srs/queue.ts`, pure): learning steps that are due, then due reviews (lowest
  retrievability first, capped per day) with new cards interleaved. When nothing else is left, learning
  cards due within `learnAheadMinutes` are shown early (Anki-style); 0 gives the strict "ends when
  nothing is due now". The queue is rebuilt after every answer, so learning steps re-enter as soon as they are due.
- **Burying:** once one direction of a country has been reviewed today, the other direction's due review
  waits until tomorrow. This is derived from `last_review`, so no extra state is stored.
- **Day boundary** at `dayStartHour` local time (default 04:00).
- **Grading** (`src/srs/grading.ts`): Easy/Good/Hard by response time; wrong = Again; typo answers are
  capped at Hard. The auto-grade is pre-selected and the user can override it before accepting.
- **Answer matching** (`src/srs/answerMatch.ts`): normalisation, aliases, Damerau–Levenshtein typo
  allowance, and an ambiguity guard. A near-miss is accepted only if it is within the allowance of the
  target and of no other country.
- **QuizController** (`src/quiz/QuizController.ts`) is the state machine:
  `idle → question → reveal → … → summary`. UI components and `QuizGlobeBinding` render from it.

## Persistence

IndexedDB through `idb`, behind `src/storage/db.ts` (`Store` interface). Schema version 2 (Phase 3) rekeys
cards by layer. The v1 → v2 migration (`src/storage/migrations.ts`) runs in the IndexedDB upgrade and on
importing a v1 export file. Object stores:
- `cards`: FSRS state and introduction day.
- `reviewLog`: append-only; the ts-fsrs log plus direction, response time, raw answer, auto-grade and final grade.
- `settings`.
- `meta`: schema version and per-layer daily counters.

Migrations are listed in `MIGRATIONS`. Export/import (`src/storage/export.ts`)
covers every store, and an import is fully validated before anything is written.

## Dev tooling

- Debug HUD (`D`): the current card's state, stability, difficulty, retrievability and due date, plus
  **time travel** buttons (+1h, +1d, +7d, reset). The clock offset lives in memory only and resets on reload.
- `?seed=demo`: ~40 countries of simulated history in the `earth-learner-demo` database. It is created
  only when that database is empty.

## Structure

```
scripts/build-data.mjs         data pipeline
src/main.ts                    bootstraps the app, wires UI to the Globe
src/config.ts                  home country, palette, zoom limits, LOD thresholds, styles
src/types.ts                   CountryId, CountryMeta, Camera, HighlightStyle, …
src/data/loadCountries.ts      fetch + decode TopoJSON, meshes, packed geometry, lookups
src/globe/Globe.ts             public API; owns state, schedules on-demand renders, picks LOD
src/globe/camera.ts            pure camera math: clamping, zoom-to-cursor solve, fit-to-bounds
src/globe/renderer.ts          Layer interface + Renderer (ordered layers, hit-testing)
src/globe/layers/              base (atmosphere, ocean, graticule, limb shade), countries, labels
src/globe/fastOrtho.ts         fast orthographic projector with hemisphere clipping
src/globe/interaction.ts       pointer / wheel / keyboard → camera, inertia, pinch
src/globe/hitTest.ts           pure hit-testing (markers first, then bbox + geoContains)
src/globe/markers.ts           small-country markers
src/globe/labels.ts            label priority, sizing, greedy collision placement
src/globe/animation.ts         flyTo path and easing
src/learn/layer.ts             LearnLayer interface (the template for new layers)
src/layers/country/            country learn layer
src/layers/city/               city data, tiers, learn layer, render layer
src/quiz/                      quiz data, QuizController (state machine), globe binding, demo seed
src/srs/                       scheduler (ts-fsrs wrapper), queue, grading, answer matching, clock
src/settings/                  settings schema (types, defaults, validation, field specs) and store
src/storage/                   IndexedDB store, export/import
src/ui/                        info panel, tooltip, zoom controls, debug HUD, mode switch, layers panel,
                               quiz panel, start screen, session summary, settings panel, map markers
data-src/                      hand-maintained quiz scope, merges, aliases
tests/                         vitest
```

### Rendering notes

- Canvas 2D, rendered only when something changes (no idle rAF loop).
- 110m while moving, 50m once idle for 150 ms. At zoom ≥ 3, 50m is also used during motion when its
  measured frame time is under 10 ms.
- Countries, mesh chunks and polygons carry bounding caps. Anything wholly behind the globe or outside the
  viewport is skipped. Geometry wholly on the near side is projected by `FastOrtho` from precomputed unit
  vectors, without clipping. Geometry that crosses the horizon is clipped by `FastOrtho` too: lines are cut,
  and polygon vertices behind the globe are clamped onto the limb. Vertices under 0.75 device px apart are
  skipped. In practice this is about 10× faster than `d3.geoPath` for the 50m data.
  d3 is still used for hit-testing (`geoContains`), bounds, centroids and interpolation.
- Antimeridian and pole "seam" edges are removed from all stroked lines.

## Globe API

```ts
const globe = new Globe(container, await loadCountries(), { homeCountry: 'GBR', labelMode: 'all' });

globe.getCamera(): Camera                       // { lon, lat, zoom }
globe.setCamera(partial)
globe.flyTo(partial, { duration? }): Promise<void>
globe.flyToCountry(id, { duration?, anchor?, minZoom?, maxZoom?, fill? }): Promise<void>
globe.flyHome() / setHomeCountry(id)
globe.homeCamera(): Camera
globe.setHighlights({ FRA: 'target', DEU: 'dimmed' })   // styles: target | correct | wrong | dimmed
globe.clearHighlights()
globe.setSelected(id | null) / getSelected()
globe.setLabelMode('none' | 'all') / getLabelMode()
globe.setInteractive(enabled)
globe.hitTest(x, y): CountryId | null
globe.on('hover' | 'click' | 'dblclick', e => …)  // { id, lonLat, x, y }; returns unsubscribe
globe.on('cameraChange', camera => …)
globe.on('render', stats => …)                    // debug: frame time, fps, LOD, layer stats
globe.addLayer(layer, { before? }) / removeLayer(id) / addLabelProvider(p)
globe.hitTestTop(x, y): HitResult | null          // any layer; events also carry `hit`
globe.flyToFit(geometry, { centre?, fill?, minZoom?, maxZoom? })
globe.project(lonLat) / countryMarkers() / redraw()
globe.destroy()
```

Selection is policy-free: the Globe reports clicks and the app decides what to select. That lets a quiz
reuse the same events.

A future layer implements `Layer` (`src/globe/renderer.ts`): `draw(ctx, projection, state)`, plus optional
`prepare` (per-view culling) and `hitTest`. It is registered with `globe.addLayer`.
