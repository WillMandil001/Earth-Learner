import { geoDistance } from 'd3-geo';
import { feature, mesh } from 'topojson-client';
import type { MultiLineString } from 'geojson';
import type { GeometryCollection, Topology } from 'topojson-specification';
import { packRings, type PackedRings } from '../globe/fastOrtho';
import type {
  CountryData,
  CountryFeature,
  CountryId,
  CountryMeta,
  Lod,
  LodGeometry,
  LonLat,
  MeshChunk,
  PolygonPart,
} from '../types';

type CountriesTopology = Topology<{ countries: GeometryCollection }>;

const MESH_CHUNK_POINTS = 128;
const SEAM_EPSILON = 1e-4;

export async function loadCountries(baseUrl = import.meta.env.BASE_URL): Promise<CountryData> {
  const get = async <T>(name: string): Promise<T> => {
    const resp = await fetch(`${baseUrl}data/${name}`);
    if (!resp.ok) throw new Error(`Failed to load ${name}: HTTP ${resp.status}`);
    return (await resp.json()) as T;
  };
  const [low, high, meta] = await Promise.all([
    get<CountriesTopology>('countries-110m.topo.json'),
    get<CountriesTopology>('countries-50m.topo.json'),
    get<CountryMeta[]>('countries-meta.json'),
  ]);
  return buildCountryData(low, high, meta);
}

/** Pure construction from already-parsed files; used directly by tests. */
export function buildCountryData(
  low: CountriesTopology,
  high: CountriesTopology,
  metaList: CountryMeta[],
): CountryData {
  const lods: Record<Lod, LodGeometry> = { low: buildLod(low), high: buildLod(high) };
  const outlines: Record<Lod, Map<CountryId, PackedRings | null>> = { low: new Map(), high: new Map() };
  return {
    meta: new Map(metaList.map((m) => [m.id, m])),
    lods,
    outline(id, lod) {
      const cache = outlines[lod];
      if (!cache.has(id)) {
        const f = lods[lod].byId.get(id);
        cache.set(id, f ? featureOutline(f) : null);
      }
      return cache.get(id) ?? null;
    },
  };
}

function buildLod(topo: CountriesTopology): LodGeometry {
  const fc = feature(topo, topo.objects.countries);
  const features = fc.features as CountryFeature[];
  return {
    features,
    byId: new Map(features.map((f) => [f.id, f])),
    parts: new Map(features.map((f) => [f.id, polygonParts(f)])),
    borders: chunkMesh(mesh(topo, topo.objects.countries, (a, b) => a !== b)),
    coastlines: chunkMesh(mesh(topo, topo.objects.countries, (a, b) => a === b)),
  };
}

function polygonRings(f: CountryFeature): LonLat[][] {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  return polys.flat() as LonLat[][];
}

function polygonParts(f: CountryFeature): PolygonPart[] {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  return polys.map((coordinates) => {
    const rings = coordinates as LonLat[][];
    return { polygon: { type: 'Polygon', coordinates }, packed: packRings(rings), cap: boundingCap(rings[0]!) };
  });
}

function featureOutline(f: CountryFeature): PackedRings {
  return packRings(polygonRings(f).flatMap((ring) => stripSeams(ring)));
}

/**
 * Natural Earth cuts polygons along the antimeridian and closes Antarctica along
 * the south pole. Those edges are artificial and would show as stroked lines,
 * so split any line wherever a segment runs along lon ±180 or lat ±90.
 */
export function stripSeams(line: LonLat[]): LonLat[][] {
  const out: LonLat[][] = [];
  let current: LonLat[] = [];
  for (let i = 0; i < line.length; i++) {
    const p = line[i]!;
    const prev = line[i - 1];
    if (prev && isSeam(prev, p)) {
      if (current.length > 1) out.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length > 1) out.push(current);
  return out;
}

function isSeam(a: LonLat, b: LonLat): boolean {
  const onMeridian = Math.abs(Math.abs(a[0]) - 180) < SEAM_EPSILON && Math.abs(a[0] - b[0]) < SEAM_EPSILON;
  const onPole = Math.abs(Math.abs(a[1]) - 90) < SEAM_EPSILON && Math.abs(a[1] - b[1]) < SEAM_EPSILON;
  return onMeridian || onPole;
}

function chunkMesh(m: MultiLineString): MeshChunk[] {
  const chunks: MeshChunk[] = [];
  for (const line of m.coordinates) {
    for (const part of stripSeams(line as LonLat[])) {
      for (let i = 0; i < part.length - 1; i += MESH_CHUNK_POINTS - 1) {
        const coordinates = part.slice(i, i + MESH_CHUNK_POINTS);
        chunks.push({ coordinates, packed: packRings([coordinates]), cap: boundingCap(coordinates) });
      }
    }
  }
  return chunks;
}

/** Cap centred on the mean direction of the points, radius = farthest point (degrees). */
export function boundingCap(points: LonLat[]): [number, number, number] {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const [lon, lat] of points) {
    const l = (lon * Math.PI) / 180;
    const p = (lat * Math.PI) / 180;
    x += Math.cos(p) * Math.cos(l);
    y += Math.cos(p) * Math.sin(l);
    z += Math.sin(p);
  }
  const centre: LonLat = [
    (Math.atan2(y, x) * 180) / Math.PI,
    (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI,
  ];
  let r = 0;
  for (const p of points) r = Math.max(r, geoDistance(centre, p));
  return [centre[0], centre[1], (r * 180) / Math.PI + 0.01];
}
