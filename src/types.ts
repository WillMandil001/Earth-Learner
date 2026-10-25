import type { Feature, MultiPolygon, Polygon } from 'geojson';
import type { HIGHLIGHT_STYLES } from './config';
import type { PackedRings } from './globe/fastOrtho';

/** Natural Earth ADM0_A3 code, e.g. "GBR". Stable across NE releases (unlike ISO_A3). */
export type CountryId = string;

export type LonLat = [lon: number, lat: number];

export interface Camera {
  /** Longitude of the view centre, degrees in [-180, 180). */
  lon: number;
  /** Latitude of the view centre, degrees in [-90, 90]. */
  lat: number;
  /** 1 = whole globe fits the shorter viewport side with a small margin. */
  zoom: number;
}

export type HighlightStyle = keyof typeof HIGHLIGHT_STYLES;
export type LabelMode = 'none' | 'all';
/** 'low' = 110m (used while moving), 'high' = 50m (used when idle). */
export type Lod = 'low' | 'high';

/** One record per country from public/data/countries-meta.json. */
export interface CountryMeta {
  id: CountryId;
  name: string;
  nameLong: string;
  formalName: string;
  /** NE TYPE: "Sovereign country", "Country", "Dependency", "Disputed", "Indeterminate", "Sovereignty". */
  type: string;
  sovereignty: string;
  continent: string;
  regionUn: string;
  subregion: string;
  /** NE curated label point (LABEL_X, LABEL_Y). */
  labelPoint: LonLat;
  labelRank: number;
  minLabel: number;
  mapColor7: number;
  /** 0–6 palette index: MAPCOLOR7 - 1, corrected so land neighbours always differ. */
  colorIndex: number;
  popEst: number;
  isoA2: string | null;
  /** Countries sharing a land border (from topojson.neighbors on 50m). */
  neighbours: CountryId[];
  /** [west, south, east, north] from d3.geoBounds; west > east when crossing the antimeridian. */
  bbox: [number, number, number, number];
  /** Bounding cap [lon, lat, radiusDegrees] enclosing the whole feature. */
  cap: [number, number, number];
  /** Spherical area in steradians (d3.geoArea). */
  area: number;
}

export type CountryFeature = Feature<Polygon | MultiPolygon, Record<string, unknown>> & { id: CountryId };

/** A piece of a line mesh with a bounding cap so it can be culled per frame. */
export interface MeshChunk {
  coordinates: LonLat[];
  packed: PackedRings;
  cap: [number, number, number];
}

/** One polygon (outer ring + holes) of a country. */
export interface PolygonPart {
  polygon: Polygon;
  packed: PackedRings;
  cap: [number, number, number];
}

export interface LodGeometry {
  features: CountryFeature[];
  byId: Map<CountryId, CountryFeature>;
  /** Each feature's polygons, packed for the fast renderer and individually cullable. */
  parts: Map<CountryId, PolygonPart[]>;
  /** Internal land borders, seams along the antimeridian removed. */
  borders: MeshChunk[];
  /** Coastlines (edges belonging to a single country), seams removed. */
  coastlines: MeshChunk[];
}

export interface CountryData {
  meta: Map<CountryId, CountryMeta>;
  lods: Record<Lod, LodGeometry>;
  /** Cached per-feature outline (rings as lines, seams removed), packed for FastOrtho. */
  outline(id: CountryId, lod: Lod): PackedRings | null;
}
