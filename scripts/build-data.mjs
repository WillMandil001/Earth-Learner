// Builds the country datasets in public/data from Natural Earth Admin 0 – Countries.
// Usage: npm run build:data   (add --refresh to re-download the cached sources)

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mapshaper from 'mapshaper';
import * as topojson from 'topojson-client';
import { geoArea, geoBounds, geoCentroid, geoContains, geoDistance } from 'd3-geo';
import polylabel from 'polylabel';
import { computeTiers } from '../src/layers/city/tiers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_SRC = join(ROOT, 'data-src');
const CACHE = join(ROOT, 'scripts', '.cache');
const OUT = join(ROOT, 'public', 'data');
const NE_GEOJSON = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';

// Canonical property names. Source fields are matched case-insensitively because
// casing differs between Natural Earth releases.
const FIELDS = [
  'ADM0_A3', 'NAME', 'NAME_LONG', 'FORMAL_EN', 'TYPE', 'SOVEREIGNT',
  'CONTINENT', 'REGION_UN', 'SUBREGION', 'LABEL_X', 'LABEL_Y',
  'LABELRANK', 'MIN_LABEL', 'MAPCOLOR7', 'POP_EST', 'ISO_A2_EH',
];
const QUANTIZATION = { '110m': 50000, '50m': 100000 };
const SOVEREIGN_TYPES = new Set(['Sovereign country', 'Country', 'Sovereignty']);
const EARTH_RADIUS_KM = 6371.0088;
/** Quiz scopes: name → source file. Add e.g. 'sovereign+dependencies' here later. */
const SCOPES = { sovereign: 'scope-sovereign.json' };

/** A Natural Earth GeoJSON file, downloaded once into scripts/.cache. */
async function fetchNe(name) {
  const file = join(CACHE, `${name}.geojson`);
  if (!existsSync(file) || process.argv.includes('--refresh')) {
    console.log(`Downloading ${name}…`);
    const resp = await fetch(`${NE_GEOJSON}/${name}.geojson`);
    if (!resp.ok) throw new Error(`Download failed for ${name}: HTTP ${resp.status}`);
    await mkdir(CACHE, { recursive: true });
    await writeFile(file, Buffer.from(await resp.arrayBuffer()));
  }
  return JSON.parse(await readFile(file, 'utf8'));
}

const fetchSource = (res) => fetchNe(`ne_${res}_admin_0_countries`);

function normaliseProperties(geojson, res) {
  const sample = geojson.features[0].properties;
  const lookup = new Map(Object.keys(sample).map((k) => [k.toUpperCase(), k]));
  const missing = FIELDS.filter((f) => !lookup.has(f));
  if (missing.length) throw new Error(`${res}: source is missing fields ${missing.join(', ')}`);
  for (const f of geojson.features) {
    const p = f.properties;
    f.properties = Object.fromEntries(FIELDS.map((k) => [k, p[lookup.get(k)] ?? null]));
  }
  return geojson;
}

async function toTopo(geojson, res) {
  const out = await mapshaper.applyCommands(
    `-i in.json -rename-layers countries -o out.json format=topojson id-field=ADM0_A3 quantization=${QUANTIZATION[res]}`,
    { 'in.json': JSON.stringify(geojson) },
  );
  return JSON.parse(out['out.json'].toString());
}

// Greedy recolour of any feature whose MAPCOLOR7 matches a neighbour's, so that
// adjacent countries are always visually distinct (NE's colouring is not perfect).
function resolveColours(records) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const conflicts = [];
  for (const r of records) {
    const taken = new Set(r.neighbours.map((n) => byId.get(n).colorIndex));
    if (!taken.has(r.colorIndex)) continue;
    const free = [0, 1, 2, 3, 4, 5, 6].find((c) => !taken.has(c));
    if (free === undefined) throw new Error(`No free colour for ${r.id}`);
    conflicts.push(`${r.id} (${r.colorIndex} → ${free})`);
    r.colorIndex = free;
  }
  return conflicts;
}

// A bounding cap (centre + angular radius, degrees) used for fast far-side culling.
function boundingCap(feature) {
  const centre = geoCentroid(feature);
  let radius = 0;
  const visit = (c) => {
    if (typeof c[0] === 'number') radius = Math.max(radius, geoDistance(centre, c));
    else c.forEach(visit);
  };
  visit(feature.geometry.coordinates);
  const deg = (radius * 180) / Math.PI;
  return [round(centre[0], 3), round(centre[1], 3), round(Math.min(180, deg + 0.5), 3)];
}

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

const readSource = async (name) => JSON.parse(await readFile(join(DATA_SRC, name), 'utf8'));

/** Fails the build unless every scope entry maps to exactly one feature. */
async function loadScopes(features) {
  const counts = new Map();
  for (const f of features) counts.set(f.properties.ADM0_A3, (counts.get(f.properties.ADM0_A3) ?? 0) + 1);
  const scopes = {};
  for (const [scope, file] of Object.entries(SCOPES)) {
    const { entries } = await readSource(file);
    const bad = entries.filter((e) => counts.get(e.id) !== 1);
    const dupes = entries.filter((e, i) => entries.findIndex((x) => x.id === e.id) !== i);
    if (bad.length || dupes.length) {
      throw new Error(
        `Scope '${scope}': ${bad.map((e) => `${e.name} (${e.id}) matches ${counts.get(e.id) ?? 0} features`).join('; ')}` +
          (dupes.length ? `; duplicate entries ${dupes.map((e) => e.id).join(', ')}` : ''),
      );
    }
    scopes[scope] = entries.map((e) => e.id).sort();
  }
  return scopes;
}

async function loadMerges(features, scopeIds) {
  const ids = new Set(features.map((f) => f.properties.ADM0_A3));
  const { merges } = await readSource('scoring-merges.json');
  for (const m of merges) {
    if (!ids.has(m.id) || !ids.has(m.into)) throw new Error(`scoring-merges: unknown feature ${m.id} → ${m.into}`);
    if (scopeIds.has(m.id)) throw new Error(`scoring-merges: ${m.id} is itself a quiz item`);
    if (!scopeIds.has(m.into)) throw new Error(`scoring-merges: ${m.into} is not in scope`);
  }
  return Object.fromEntries(merges.map((m) => [m.id, m.into]));
}

async function loadNames(features, scopeIds) {
  const { countries } = await readSource('country-aliases.json');
  const props = new Map(features.map((f) => [f.properties.ADM0_A3, f.properties]));
  const missing = [...scopeIds].filter((id) => !countries[id]);
  if (missing.length) throw new Error(`country-aliases: no entry for ${missing.join(', ')}`);
  const names = {};
  for (const id of [...scopeIds].sort()) {
    const p = props.get(id);
    const { display, aliases } = countries[id];
    const accepted = [display, ...aliases, p.NAME, p.NAME_LONG, p.FORMAL_EN].filter(Boolean);
    names[id] = { display, accepted: [...new Set(accepted)] };
  }
  return names;
}

function polygonsOf(f) {
  return f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
}

/**
 * NE label points occasionally fall outside the country (e.g. New Zealand, offshore).
 * Replace those with the pole of inaccessibility of the largest polygon, computed in a
 * local equirectangular frame so longitude is not over-weighted at high latitudes.
 */
function fixLabelPoint(f, point) {
  if (geoContains(f, point)) return null;
  const largest = polygonsOf(f).reduce((a, b) =>
    geoArea({ type: 'Polygon', coordinates: b }) > geoArea({ type: 'Polygon', coordinates: a }) ? b : a,
  );
  const lon0 = largest[0][0][0];
  const lat0 = geoCentroid({ type: 'Polygon', coordinates: largest })[1];
  const k = Math.cos((lat0 * Math.PI) / 180);
  const unwrap = (lon) => lon0 + ((((lon - lon0 + 540) % 360) + 360) % 360) - 180;
  const local = largest.map((ring) => ring.map(([lon, lat]) => [unwrap(lon) * k, lat]));
  const xs = local[0].map((p) => p[0]);
  const ys = local[0].map((p) => p[1]);
  // Precision relative to the polygon, so microstates (Vatican is ~0.005°) still work.
  const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const [x, y] = polylabel(local, Math.min(0.01, extent / 200));
  const lon = ((((x / k + 180) % 360) + 360) % 360) - 180;
  const anchor = [round(lon, 5), round(y, 5)];
  if (!geoContains(f, anchor)) throw new Error(`Label anchor for ${f.id} is still outside the country`);
  return anchor;
}

// ---- Border-to-border distances ----------------------------------------------

const toVec = ([lon, lat]) => {
  const l = (lon * Math.PI) / 180;
  const p = (lat * Math.PI) / 180;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const angle = (a, b) => Math.atan2(norm(cross(a, b)), dot(a, b));

/** Angular distance from point p to the great-circle arc a→b (all unit vectors). */
function pointArc(p, a, b) {
  const n = cross(a, b);
  const len = norm(n);
  if (len > 1e-12) {
    const nh = [n[0] / len, n[1] / len, n[2] / len];
    const d = dot(p, nh);
    const q = [p[0] - d * nh[0], p[1] - d * nh[1], p[2] - d * nh[2]];
    if (dot(cross(a, q), nh) >= 0 && dot(cross(q, b), nh) >= 0) return Math.asin(Math.min(1, Math.abs(d)));
  }
  return Math.min(angle(p, a), angle(p, b));
}

const SEGMENTS_PER_CHUNK = 24;

/** Boundary segments of a feature, grouped into chunks with bounding caps. */
function boundaryChunks(f) {
  const chunks = [];
  for (const poly of polygonsOf(f)) {
    for (const ring of poly) {
      const v = ring.map(toVec);
      for (let i = 0; i < v.length - 1; i += SEGMENTS_PER_CHUNK) {
        const pts = v.slice(i, i + SEGMENTS_PER_CHUNK + 1);
        const sum = pts.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]);
        const l = norm(sum) || 1;
        const centre = [sum[0] / l, sum[1] / l, sum[2] / l];
        chunks.push({ pts, centre, radius: Math.max(...pts.map((p) => angle(centre, p))) });
      }
    }
  }
  return chunks;
}

function chunkDistance(a, b, best) {
  for (let i = 0; i < a.pts.length - 1; i++) {
    for (let j = 0; j < b.pts.length - 1; j++) {
      best = Math.min(
        best,
        pointArc(a.pts[i], b.pts[j], b.pts[j + 1]),
        pointArc(a.pts[i + 1], b.pts[j], b.pts[j + 1]),
        pointArc(b.pts[j], a.pts[i], a.pts[i + 1]),
        pointArc(b.pts[j + 1], a.pts[i], a.pts[i + 1]),
      );
    }
  }
  return best;
}

/** Branch and bound over chunk pairs, nearest-first by cap lower bound. */
function boundaryDistance(ca, cb) {
  const pairs = [];
  for (const a of ca) for (const b of cb) pairs.push([Math.max(0, angle(a.centre, b.centre) - a.radius - b.radius), a, b]);
  pairs.sort((x, y) => x[0] - y[0]);
  let best = Infinity;
  for (const [lb, a, b] of pairs) {
    if (lb >= best) break;
    best = chunkDistance(a, b, best);
  }
  return best;
}

/**
 * Minimum border-to-border distance (km) between every pair of features, on the
 * 110m-with-additions geometry. Land neighbours (50m topology) and enclosed shapes are 0.
 * Stored as the upper triangle of the matrix, row-major, for ids in sorted order.
 */
function distanceMatrix(features, neighbours) {
  const sorted = [...features].sort((a, b) => a.id.localeCompare(b.id));
  const chunks = sorted.map(boundaryChunks);
  const km = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      let d = neighbours.get(a.id)?.has(b.id) ? 0 : boundaryDistance(chunks[i], chunks[j]) * EARTH_RADIUS_KM;
      if (d > 0 && d < 300) {
        const firstA = polygonsOf(a)[0][0][0];
        const firstB = polygonsOf(b)[0][0][0];
        if (geoContains(b, firstA) || geoContains(a, firstB)) d = 0;
      }
      km.push(Math.round(d));
    }
  }
  return { ids: sorted.map((f) => f.id), km };
}

async function writeJson(name, data) {
  const file = join(OUT, name);
  const text = JSON.stringify(data);
  await writeFile(file, text);
  const raw = (await stat(file)).size;
  const gz = gzipSync(text, { level: 9 }).length;
  return { name, raw, gz };
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;


// ---- Cities ------------------------------------------------------------------

/** Cities below this population are only kept if they are a capital or their country's largest. */
const CITY_POP_FLOOR = 100_000;
/** Populated-places country codes that differ from the Admin 0 codes. */
const CITY_COUNTRY_FIX = { SSD: 'SDS' };
const NOT_CITIES = new Set(['Scientific station', 'Meteorological Station', 'Historic place']);

const slug = (s) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * cities.json: every populated place in a quiz country with population ≥ 100,000,
 * plus capitals and each country's largest place, with accepted names. Tiers are
 * computed at runtime from settings (src/layers/city/tiers.ts).
 */
async function buildCities(scopeIds, merges) {
  const places = (await fetchNe('ne_10m_populated_places')).features.map((f) => f.properties);
  const { cities: aliasSrc } = await readSource('city-aliases.json');
  const { capitals } = await readSource('capitals.json');
  const { cities: extra } = await readSource('extra-cities.json');
  const countryOf = (a) => {
    const id = merges[CITY_COUNTRY_FIX[a] ?? a] ?? CITY_COUNTRY_FIX[a] ?? a;
    return scopeIds.has(id) ? id : null;
  };

  const unmatched = [];
  const matched = [];
  for (const p of places) {
    if (NOT_CITIES.has(p.FEATURECLA)) continue;
    const country = countryOf(p.ADM0_A3);
    if (!country) {
      if (p.POP_MAX >= CITY_POP_FLOOR) unmatched.push(`${p.NAME} (${p.ADM0_A3}, ${p.ADM0NAME})`);
      continue;
    }
    const names = [p.NAME, p.NAMEASCII, p.NAME_EN, ...String(p.NAMEALT ?? '').split(/[|;]/)].map((n) => n?.trim()).filter(Boolean);
    matched.push({
      base: `${country.toLowerCase()}-${slug(p.NAME_EN || p.NAMEASCII)}`,
      adm1: p.ADM1NAME ?? '',
      neId: p.NE_ID,
      record: { i: '', n: p.NAME_EN || p.NAME, c: country, lon: round(p.LONGITUDE, 4), lat: round(p.LATITUDE, 4), p: p.POP_MAX, r: p.SCALERANK, a: names },
    });
  }
  for (const e of extra) {
    matched.push({ base: `${e.country.toLowerCase()}-${slug(e.name)}`, adm1: '', neId: 0, record: { i: '', n: e.name, c: e.country, lon: e.lon, lat: e.lat, p: e.pop, r: 10, a: [e.name] } });
  }

  // Stable IDs: the most populous place keeps the plain slug; namesakes in the same country get their region appended.
  const groups = new Map();
  for (const m of matched) groups.set(m.base, [...(groups.get(m.base) ?? []), m]);
  for (const group of groups.values()) {
    group.sort((a, b) => b.record.p - a.record.p || a.neId - b.neId);
    const used = new Set();
    group.forEach((m, i) => {
      let id = i === 0 ? m.base : `${m.base}-${slug(m.adm1) || m.neId}`;
      if (used.has(id)) id = `${id}-${m.neId}`;
      used.add(id);
      m.record.i = id;
    });
  }

  const byId = new Map(matched.map((m) => [m.record.i, m.record]));
  const capitalIds = new Set();
  const capitalOut = {};
  for (const country of scopeIds) {
    const cap = capitals[country];
    if (!cap) throw new Error(`capitals.json: no capital for ${country}`);
    const city = byId.get(cap.city);
    if (!city) throw new Error(`capitals.json: ${country} capital "${cap.city}" is not a known city`);
    if (city.c !== country) throw new Error(`capitals.json: ${cap.city} is not in ${country}`);
    capitalIds.add(cap.city);
    capitalOut[country] = { city: cap.city, alsoAccept: cap.alsoAccept };
  }
  const largest = new Map();
  for (const m of matched) if (!largest.has(m.record.c) || m.record.p > largest.get(m.record.c).p) largest.set(m.record.c, m.record);
  const largestIds = new Set([...largest.values()].map((c) => c.i));

  const unknownAliases = Object.keys(aliasSrc).filter((id) => !byId.has(id));
  if (unknownAliases.length) throw new Error(`city-aliases.json: unknown city IDs ${unknownAliases.join(', ')}`);
  const cities = matched
    .map((m) => m.record)
    .filter((c) => c.p >= CITY_POP_FLOOR || capitalIds.has(c.i) || largestIds.has(c.i))
    .map((c) => {
      const extraNames = aliasSrc[c.i];
      const n = extraNames?.display ?? c.n;
      const reject = new Set(extraNames?.reject ?? []);
      // Natural Earth's alternate names include a few garbled fragments; drop very short ones and any rejected.
      const a = [...new Set([c.n, ...c.a, ...(extraNames?.aliases ?? [])])].filter(
        (x) => x !== n && !reject.has(x) && x.replace(/[^\p{L}\p{N}]/gu, '').length >= 3,
      );
      return { ...c, n, ...(a.length ? { a } : { a: undefined }) };
    })
    .sort((a, b) => a.i.localeCompare(b.i));

  const tiers = computeTiers(cities, capitalOut, { majorPopThreshold: 1_000_000, majorMaxPerCountry: 8, homeCountryPopThreshold: 200_000, home: 'GBR' });
  const missingAliases = cities.filter((c) => (tiers.get(c.i) === 'capital' || tiers.get(c.i) === 'major') && !aliasSrc[c.i]);
  return { file: { version: 1, popFloor: CITY_POP_FLOOR, capitals: capitalOut, cities }, tiers, unmatched, capitals, missingAliases };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const src50 = normaliseProperties(await fetchSource('50m'), '50m');
  const src110 = normaliseProperties(await fetchSource('110m'), '110m');

  const warnings = [];
  for (const [res, src] of [['110m', src110], ['50m', src50]]) {
    const ids = src.features.map((f) => f.properties.ADM0_A3);
    const bad = src.features.filter((f) => !f.properties.ADM0_A3 || f.properties.ADM0_A3 === '-99');
    const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    if (bad.length) warnings.push(`${res}: missing IDs for ${bad.map((f) => f.properties.NAME).join(', ')}`);
    if (dupes.length) warnings.push(`${res}: duplicate IDs ${dupes.join(', ')}`);
  }

  // 110m omits many small states. Fill the gaps with their 50m geometry so the
  // low-detail set used during motion is complete and nothing blinks out.
  const ids110 = new Set(src110.features.map((f) => f.properties.ADM0_A3));
  const supplemented = src50.features.filter((f) => !ids110.has(f.properties.ADM0_A3));
  const only110 = src110.features.filter(
    (f) => !src50.features.some((g) => g.properties.ADM0_A3 === f.properties.ADM0_A3),
  );
  if (only110.length) warnings.push(`present at 110m but not 50m: ${only110.map((f) => f.properties.ADM0_A3).join(', ')}`);
  const low = { ...src110, features: [...src110.features, ...supplemented] };

  const topo50 = await toTopo(src50, '50m');
  const topo110 = await toTopo(low, '110m');

  // Validate winding: d3-geo treats a polygon covering more than a hemisphere as inverted.
  for (const [res, topo] of [['110m', topo110], ['50m', topo50]]) {
    const fc = topojson.feature(topo, topo.objects.countries);
    const inverted = fc.features.filter((f) => geoArea(f) > 2 * Math.PI);
    if (inverted.length) warnings.push(`${res}: inverted winding for ${inverted.map((f) => f.id).join(', ')}`);
  }

  const geoms50 = topo50.objects.countries.geometries;
  const fc50 = topojson.feature(topo50, topo50.objects.countries);
  const neighbourIdx = topojson.neighbors(geoms50);
  const records = fc50.features.map((f, i) => {
    const p = f.properties;
    const [[w, s], [e, n]] = geoBounds(f);
    return {
      id: p.ADM0_A3,
      name: p.NAME,
      nameLong: p.NAME_LONG,
      formalName: p.FORMAL_EN || p.NAME_LONG,
      type: p.TYPE,
      sovereignty: p.SOVEREIGNT,
      continent: p.CONTINENT,
      regionUn: p.REGION_UN,
      subregion: p.SUBREGION,
      labelPoint: [round(p.LABEL_X, 4), round(p.LABEL_Y, 4)],
      labelRank: p.LABELRANK,
      minLabel: p.MIN_LABEL,
      mapColor7: p.MAPCOLOR7,
      colorIndex: p.MAPCOLOR7 - 1,
      popEst: p.POP_EST,
      isoA2: p.ISO_A2_EH === '-99' ? null : p.ISO_A2_EH,
      neighbours: neighbourIdx[i].map((j) => geoms50[j].id).sort(),
      bbox: [w, s, e, n].map((x) => round(x, 4)),
      cap: boundingCap(f),
      area: geoArea(f),
    };
  });
  records.sort((a, b) => a.id.localeCompare(b.id));
  const recoloured = resolveColours(records);

  const featureById = new Map(fc50.features.map((f) => [f.id, f]));
  const movedLabels = [];
  for (const r of records) {
    const fixed = fixLabelPoint(featureById.get(r.id), r.labelPoint);
    if (!fixed) continue;
    movedLabels.push(`${r.id} ${r.name}: [${r.labelPoint}] → [${fixed}]`);
    r.neLabelPoint = r.labelPoint;
    r.labelPoint = fixed;
  }

  const scopes = await loadScopes(src50.features);
  const scopeIds = new Set(Object.values(scopes).flat());
  const merges = await loadMerges(src50.features, scopeIds);
  const names = await loadNames(src50.features, scopeIds);
  const cityData = await buildCities(scopeIds, merges);

  const t0 = performance.now();
  const fc110 = topojson.feature(topo110, topo110.objects.countries);
  const neighbours = new Map(records.map((r) => [r.id, new Set(r.neighbours)]));
  const distances = distanceMatrix(fc110.features, neighbours);
  const distanceMs = performance.now() - t0;

  const files = [
    await writeJson('countries-110m.topo.json', topo110),
    await writeJson('countries-50m.topo.json', topo50),
    await writeJson('countries-meta.json', records),
    await writeJson('quiz-data.json', { version: 1, scopes, merges, names }),
    await writeJson('country-distances.json', distances),
    await writeJson('cities.json', cityData.file),
  ];

  const missingSovereign = supplemented
    .filter((f) => SOVEREIGN_TYPES.has(f.properties.TYPE))
    .map((f) => `${f.properties.ADM0_A3} ${f.properties.NAME}`);

  console.log('\n=== Validation summary ===');
  console.log(`Features: 110m source ${src110.features.length}, 50m source ${src50.features.length}`);
  console.log(`110m output: ${src110.features.length} + ${supplemented.length} supplemented from 50m = ${low.features.length}`);
  console.log(`Sovereign/country features missing at 110m (${missingSovereign.length}):\n  ${missingSovereign.join(', ')}`);
  console.log(`Countries with no land neighbours: ${records.filter((r) => !r.neighbours.length).length}`);
  console.log(`MAPCOLOR7 neighbour conflicts fixed (${recoloured.length}): ${recoloured.join(', ') || 'none'}`);
  console.log(`Label anchors moved inside their country (${movedLabels.length}):\n  ${movedLabels.join('\n  ') || 'none'}`);
  console.log(`Scopes: ${Object.entries(scopes).map(([k, v]) => `${k} ${v.length}`).join(', ')}; scoring merges: ${Object.entries(merges).map(([a, b]) => `${a}→${b}`).join(', ')}`);
  const tierCounts = { capital: 0, major: 0, extended: 0 };
  const perCountry = new Map();
  for (const [id, t] of cityData.tiers) {
    tierCounts[t]++;
    if (t !== 'extended') perCountry.set(id.slice(0, 3), (perCountry.get(id.slice(0, 3)) ?? 0) + 1);
  }
  console.log(`Cities: ${cityData.file.cities.length} in cities.json; default tiers (home GBR): ${JSON.stringify(tierCounts)}`);
  console.log(`  Top 10 countries by capital+major cities: ${[...perCountry].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c, n]) => `${c.toUpperCase()} ${n}`).join(', ')}`);
  console.log(`  Unmatched places ≥ ${CITY_POP_FLOOR.toLocaleString()} (not in quiz scope): ${cityData.unmatched.join('; ') || 'none'}`);
  const flagged = Object.entries(cityData.capitals).filter(([, v]) => v.flagged);
  console.log(`  Capitals flagged for review (${flagged.length}): ${flagged.map(([c, v]) => `${c} → ${v.city}${v.alsoAccept.length ? ` (+${v.alsoAccept.join(', ')})` : ''}`).join('; ')}`);
  if (cityData.missingAliases.length) console.log(`  Capital/major cities without an aliases entry (${cityData.missingAliases.length}): ${cityData.missingAliases.map((c) => c.i).join(', ')}`);
  console.log(`Distance matrix: ${distances.ids.length} features, ${distances.km.length} pairs in ${(distanceMs / 1000).toFixed(1)} s`);
  console.log(warnings.length ? `Warnings:\n  ${warnings.join('\n  ')}` : 'ID / winding issues: none');
  console.log('Output files:');
  for (const f of files) console.log(`  ${f.name.padEnd(28)} ${kb(f.raw).padStart(10)} raw  ${kb(f.gz).padStart(10)} gzip`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
