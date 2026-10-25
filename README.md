# Earth Learner

A fast, local, canvas-rendered 3D-looking globe for learning world geography.

- **Explore** (Phase 1): spin, zoom, hover and click countries.
- **Learn** (Phase 2): spaced-repetition questions about the 197 sovereign states, introduced outward from
  your home country. "Find it" (click the country) and "Name it" (type the highlighted country's name),
  scheduled with FSRS. Progress is stored locally in IndexedDB.

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
| `public/data/country-distances.json` | Border-to-border great-circle distance (km) between every pair of features, on the 110m-with-additions geometry. Neighbours and enclaves are 0. Stored as the upper triangle in sorted-ID order. |

Hand-maintained sources live in `data-src/`:
- `scope-sovereign.json`: the quiz items. The build fails unless each maps to exactly one feature.
- `scoring-merges.json`: non-items that count as their parent when clicked (Somaliland → Somalia, …).
- `country-aliases.json`: display names and alternative answers.

Natural Earth label points that fall outside their country (e.g. New Zealand's) are replaced by the
pole of inaccessibility of the largest polygon (`polylabel`).

The country ID is `ADM0_A3` (`ISO_A3` is `-99` for France, Norway, …). `MAPCOLOR7` is checked against the
neighbour graph and corrected where neighbours clash (`colorIndex`). The generated files are checked in, so
the app runs without re-running the script.

## Learning model

- A **card** is `(country, direction)`, with direction `locate` or `name`. A card with no stored state is new.
- **FSRS** via `ts-fsrs`, wrapped in `src/srs/scheduler.ts` (nothing else imports it).
- **New countries:** up to `newPerDay` per day, in order of distance from home (ties by LABELRANK).
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

IndexedDB through `idb`, behind `src/storage/db.ts` (`Store` interface). Object stores:
- `cards`: FSRS state and introduction day.
- `reviewLog`: append-only; the ts-fsrs log plus direction, response time, raw answer, auto-grade and final grade.
- `settings`.
- `meta`: schema version and daily counters.

The schema version is 1, and migrations are listed in `MIGRATIONS`. Export/import (`src/storage/export.ts`)
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
src/quiz/                      quiz data, QuizController (state machine), globe binding, demo seed
src/srs/                       scheduler (ts-fsrs wrapper), queue, grading, answer matching, clock
src/settings/                  settings schema (types, defaults, validation, field specs) and store
src/storage/                   IndexedDB store, export/import
src/ui/                        info panel, tooltip, zoom controls, debug HUD, mode switch,
                               quiz panel, start screen, session summary, settings panel
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
globe.flyToCountry(id, { duration?, anchor?, maxZoom?, fill? }): Promise<void>
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
globe.addLayer(layer, { before? }) / removeLayer(id)
globe.destroy()
```

Selection is policy-free: the Globe reports clicks and the app decides what to select. That lets a quiz
reuse the same events.

A future layer implements `Layer` (`src/globe/renderer.ts`): `draw(ctx, projection, state)`, plus optional
`prepare` (per-view culling) and `hitTest`. It is registered with `globe.addLayer`.
