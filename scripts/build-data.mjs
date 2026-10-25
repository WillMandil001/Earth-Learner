// Builds the country datasets in public/data from Natural Earth Admin 0 – Countries.
// Usage: npm run build:data   (add --refresh to re-download the cached sources)

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mapshaper from 'mapshaper';
import * as topojson from 'topojson-client';
import { geoArea, geoBounds, geoCentroid, geoDistance } from 'd3-geo';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scripts', '.cache');
const OUT = join(ROOT, 'public', 'data');
const SOURCE = (res) =>
  `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_${res}_admin_0_countries.geojson`;

// Canonical property names. Source fields are matched case-insensitively because
// casing differs between Natural Earth releases.
const FIELDS = [
  'ADM0_A3', 'NAME', 'NAME_LONG', 'FORMAL_EN', 'TYPE', 'SOVEREIGNT',
  'CONTINENT', 'REGION_UN', 'SUBREGION', 'LABEL_X', 'LABEL_Y',
  'LABELRANK', 'MIN_LABEL', 'MAPCOLOR7', 'POP_EST', 'ISO_A2_EH',
];
const QUANTIZATION = { '110m': 50000, '50m': 100000 };
const SOVEREIGN_TYPES = new Set(['Sovereign country', 'Country', 'Sovereignty']);

async function fetchSource(res) {
  const file = join(CACHE, `ne_${res}_admin_0_countries.geojson`);
  if (!existsSync(file) || process.argv.includes('--refresh')) {
    console.log(`Downloading ${res}…`);
    const resp = await fetch(SOURCE(res));
    if (!resp.ok) throw new Error(`Download failed for ${res}: HTTP ${resp.status}`);
    await mkdir(CACHE, { recursive: true });
    await writeFile(file, Buffer.from(await resp.arrayBuffer()));
  }
  return JSON.parse(await readFile(file, 'utf8'));
}

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

async function writeJson(name, data) {
  const file = join(OUT, name);
  const text = JSON.stringify(data);
  await writeFile(file, text);
  const raw = (await stat(file)).size;
  const gz = gzipSync(text, { level: 9 }).length;
  return { name, raw, gz };
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

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

  const files = [
    await writeJson('countries-110m.topo.json', topo110),
    await writeJson('countries-50m.topo.json', topo50),
    await writeJson('countries-meta.json', records),
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
  console.log(warnings.length ? `Warnings:\n  ${warnings.join('\n  ')}` : 'ID / winding issues: none');
  console.log('Output files:');
  for (const f of files) console.log(`  ${f.name.padEnd(28)} ${kb(f.raw).padStart(10)} raw  ${kb(f.gz).padStart(10)} gzip`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
