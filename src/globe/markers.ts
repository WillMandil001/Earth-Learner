import { geoDistance } from 'd3-geo';
import type { GeoProjection } from 'd3-geo';
import { SMALL_COUNTRY } from '../config';
import type { CountryMeta, LonLat } from '../types';
import type { Viewport } from './camera';
import type { Marker } from './hitTest';

/** Marker opacity for a projected polygon area (CSS px²): 1 when tiny, fading (log scale) to 0. */
export function markerAlpha(area: number): number {
  const { markerFullArea: full, markerHideArea: hide } = SMALL_COUNTRY;
  if (area <= full) return 1;
  if (area >= hide) return 0;
  return 1 - Math.log(area / full) / Math.log(hide / full);
}

/**
 * Markers for countries too small to see or click at the current scale.
 * Projected area is estimated from spherical area × r² × foreshortening, which
 * is far cheaper than projecting every polygon each frame.
 */
export function computeMarkers(
  metas: Iterable<CountryMeta>,
  projection: GeoProjection,
  centre: LonLat,
  radius: number,
  vp: Viewport,
): Marker[] {
  const markers: Marker[] = [];
  const pad = SMALL_COUNTRY.hitRadius;
  for (const m of metas) {
    const c = geoDistance(centre, m.labelPoint);
    if (c > Math.PI / 2 - 0.01) continue;
    const alpha = markerAlpha(m.area * radius * radius * Math.cos(c));
    if (alpha <= 0) continue;
    const p = projection(m.labelPoint);
    if (!p) continue;
    const [x, y] = p;
    if (x < -pad || y < -pad || x > vp.width + pad || y > vp.height + pad) continue;
    markers.push({ id: m.id, x, y, alpha });
  }
  return markers;
}
