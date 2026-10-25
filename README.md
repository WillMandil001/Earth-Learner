# Earth Learner — Phase 1: the globe

A fast, local, canvas-rendered 3D-looking globe for learning world geography.
Phase 1 is the globe and its interaction only (no quizzes / spaced repetition yet).

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

Controls: drag to rotate (with inertia), wheel / trackpad pinch / two-finger pinch to zoom toward the cursor,
click to select, double-click to fly to a country. Keys: arrows rotate, `+`/`-` zoom, `H` home,
`L` toggle labels, `D` debug HUD.

## Data

`scripts/build-data.mjs` downloads Natural Earth Admin 0 – Countries (110m and 50m GeoJSON from
`nvkelso/natural-earth-vector`, public domain), caches them in `scripts/.cache/`, and writes:

| File | Contents |
| --- | --- |
| `public/data/countries-110m.topo.json` | Low detail, used while moving. 110m lacks 65 small countries, so their 50m geometry is merged in, giving every country at both levels. |
| `public/data/countries-50m.topo.json` | High detail, used when idle and for hit-testing. |
| `public/data/countries-meta.json` | One record per country: names, type, continent/region, label point, label rank, colour, population, land neighbours (`topojson.neighbors` on 50m), `geoBounds` bbox, bounding cap, spherical area. |

The country ID is `ADM0_A3` (`ISO_A3` is `-99` for France, Norway, …). `MAPCOLOR7` is checked against the
neighbour graph and corrected where neighbours clash (`colorIndex`). The generated files are checked in, so
the app runs without re-running the script.

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
src/ui/                        info panel, tooltip, zoom controls, debug HUD
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
globe.flyToCountry(id, { duration? }): Promise<void>
globe.flyHome()
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
