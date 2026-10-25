import { geoContains } from 'd3-geo';
import type { CountryFeature, CountryId, CountryMeta, LonLat } from '../types';

/** A small-country marker as drawn on screen (CSS px). */
export interface Marker {
  id: CountryId;
  x: number;
  y: number;
  /** 0–1; markers fade out as the real polygon becomes big enough to see. */
  alpha: number;
}

/** Markers below this opacity are not clickable. */
const MIN_HIT_ALPHA = 0.25;

export function inBBox([lon, lat]: LonLat, [w, s, e, n]: CountryMeta['bbox']): boolean {
  if (lat < s || lat > n) return false;
  return w <= e ? lon >= w && lon <= e : lon >= w || lon <= e;
}

/** Nearest visible marker within `radius` px of (x, y). */
export function hitTestMarkers(markers: readonly Marker[], x: number, y: number, radius: number): CountryId | null {
  let best: CountryId | null = null;
  let bestD = radius;
  for (const m of markers) {
    if (m.alpha < MIN_HIT_ALPHA) continue;
    const d = Math.hypot(m.x - x, m.y - y);
    if (d <= bestD) {
      bestD = d;
      best = m.id;
    }
  }
  return best;
}

/**
 * Country polygon containing `p`. Prefilters by bounding box, then geoContains.
 * If several match (enclaves, slight overlaps in the source data) the smallest wins.
 */
export function hitTestPolygons(
  p: LonLat,
  features: readonly CountryFeature[],
  meta: ReadonlyMap<CountryId, CountryMeta>,
): CountryId | null {
  let best: CountryMeta | null = null;
  for (const f of features) {
    const m = meta.get(f.id);
    if (!m || !inBBox(p, m.bbox)) continue;
    if ((!best || m.area < best.area) && geoContains(f, p)) best = m;
  }
  return best?.id ?? null;
}

/** Markers first (they are what the user sees for tiny countries), then polygons. */
export function hitTestCountries(
  screen: [number, number],
  geo: LonLat | null,
  markers: readonly Marker[],
  markerRadius: number,
  features: readonly CountryFeature[],
  meta: ReadonlyMap<CountryId, CountryMeta>,
): CountryId | null {
  return hitTestMarkers(markers, screen[0], screen[1], markerRadius) ?? (geo ? hitTestPolygons(geo, features, meta) : null);
}
