import { geoArea, geoCentroid, geoDistance, geoOrthographic, geoPath } from 'd3-geo';
import type { GeoPermissibleObjects, GeoProjection } from 'd3-geo';
import type { MultiPolygon, Polygon } from 'geojson';
import { GLOBE_MARGIN, ZOOM_LIMITS } from '../config';
import type { Camera, CountryFeature, LonLat } from '../types';

export interface Viewport {
  width: number;
  height: number;
}

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/** Globe radius in CSS px at zoom 1. */
export function baseRadius(vp: Viewport): number {
  return (Math.min(vp.width, vp.height) / 2) * (1 - GLOBE_MARGIN);
}

export function globeRadius(cam: Camera, vp: Viewport): number {
  return baseRadius(vp) * cam.zoom;
}

export function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_LIMITS.max, Math.max(ZOOM_LIMITS.min, zoom));
}

export function clampCamera(cam: Camera): Camera {
  return {
    lon: wrapLon(cam.lon),
    lat: Math.min(90, Math.max(-90, cam.lat)),
    zoom: clampZoom(cam.zoom),
  };
}

export function makeProjection(cam: Camera, vp: Viewport): GeoProjection {
  return updateProjection(geoOrthographic().clipAngle(90).precision(0.7), cam, vp);
}

/** Point a projection at a camera. North stays up: there is never any roll. */
export function updateProjection(proj: GeoProjection, cam: Camera, vp: Viewport): GeoProjection {
  return proj
    .scale(globeRadius(cam, vp))
    .translate([vp.width / 2, vp.height / 2])
    .rotate([-cam.lon, -cam.lat, 0]);
}

/** Geographic point under a screen point, or null if the screen point is off the globe. */
export function screenToLonLat(cam: Camera, vp: Viewport, x: number, y: number): LonLat | null {
  const r = globeRadius(cam, vp);
  if (Math.hypot(x - vp.width / 2, y - vp.height / 2) > r) return null;
  const p = makeProjection(cam, vp).invert?.([x, y]);
  return p && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? [p[0], p[1]] : null;
}

/**
 * Solve for the camera centre (no roll) that places geographic point `geo` at
 * screen offset (dx, dy) from the viewport centre, with globe radius `r` px.
 * There are up to two solutions; the one nearest `near` wins. Returns null when
 * no north-up camera can do it (e.g. the point is too close to a pole).
 */
export function solveCentreForAnchor(
  geo: LonLat,
  dx: number,
  dy: number,
  r: number,
  near: LonLat,
): LonLat | null {
  const x = dx / r;
  const y = -dy / r;
  const zz = 1 - x * x - y * y;
  if (zz < 0) return null;
  const z = Math.sqrt(zz);
  const lam = geo[0] * RAD;
  const phi = geo[1] * RAD;
  const cosPhi = Math.cos(phi);
  if (Math.abs(x) > cosPhi + 1e-12) return null;
  const sinD = cosPhi === 0 ? 0 : Math.max(-1, Math.min(1, x / cosPhi));
  const d1 = Math.asin(sinD);
  let best: LonLat | null = null;
  let bestDist = Infinity;
  for (const delta of [d1, Math.PI - d1]) {
    const a = Math.sin(phi);
    const b = cosPhi * Math.cos(delta);
    let phi0 = Math.atan2(a, b) - Math.atan2(y, z);
    if (phi0 > Math.PI) phi0 -= 2 * Math.PI;
    if (phi0 < -Math.PI) phi0 += 2 * Math.PI;
    if (Math.abs(phi0) > Math.PI / 2 + 1e-9) continue;
    const cand: LonLat = [wrapLon((lam - delta) * DEG), Math.max(-90, Math.min(90, phi0 * DEG))];
    const dist = geoDistance(cand, near);
    if (dist < bestDist) {
      bestDist = dist;
      best = cand;
    }
  }
  return best;
}

/** Camera at `zoom` that keeps `geo` at screen point (x, y); falls back to the plain zoom. */
export function cameraWithPointAt(geo: LonLat, x: number, y: number, zoom: number, current: Camera, vp: Viewport): Camera {
  const z = clampZoom(zoom);
  const r = baseRadius(vp) * z;
  const centre = solveCentreForAnchor(geo, x - vp.width / 2, y - vp.height / 2, r, [current.lon, current.lat]);
  return clampCamera(centre ? { lon: centre[0], lat: centre[1], zoom: z } : { ...current, zoom: z });
}

/** Zoom so the geographic point under (x, y) stays under (x, y). */
export function zoomAtPoint(cam: Camera, zoom: number, x: number, y: number, vp: Viewport): Camera {
  const geo = screenToLonLat(cam, vp, x, y);
  if (!geo) return clampCamera({ ...cam, zoom });
  return cameraWithPointAt(geo, x, y, zoom, cam, vp);
}

/** Drag rotation: one pixel moves the surface at the view centre by one pixel. */
export function panByPixels(cam: Camera, dx: number, dy: number, vp: Viewport): Camera {
  const r = globeRadius(cam, vp);
  return clampCamera({ ...cam, lon: cam.lon - (dx / r) * DEG, lat: cam.lat + (dy / r) * DEG });
}

/**
 * Camera that frames `geom` within `fill` of the viewport. With `centre` the view
 * is centred there (zoom fits symmetric extents), otherwise on the geometry itself.
 */
export function fitCamera(
  geom: GeoPermissibleObjects,
  vp: Viewport,
  opts: { centre?: LonLat; fill?: number } = {},
): Camera {
  const fill = opts.fill ?? 0.8;
  let centre = opts.centre ?? (geoCentroid(geom) as LonLat);
  const at = (c: LonLat) => makeProjection({ lon: c[0], lat: c[1], zoom: 1 }, vp);
  if (!opts.centre) {
    // Recentre on the projected bounding box, which suits sprawling shapes better than the centroid.
    const proj = at(centre);
    const [[x0, y0], [x1, y1]] = geoPath(proj).bounds(geom);
    const mid = proj.invert?.([(x0 + x1) / 2, (y0 + y1) / 2]);
    if (mid && Number.isFinite(mid[0])) centre = [mid[0], mid[1]];
  }
  const proj = at(centre);
  const [[x0, y0], [x1, y1]] = geoPath(proj).bounds(geom);
  const cx = vp.width / 2;
  const cy = vp.height / 2;
  const halfW = Math.max(cx - x0, x1 - cx, 1e-6);
  const halfH = Math.max(cy - y0, y1 - cy, 1e-6);
  const zoom = Math.min((fill * vp.width) / 2 / halfW, (fill * vp.height) / 2 / halfH);
  return clampCamera({ lon: centre[0], lat: centre[1], zoom: Number.isFinite(zoom) ? zoom : 1 });
}

/**
 * The parts of a country worth framing: the largest polygon plus any sizeable
 * polygon near it. Excludes far-flung territories (French Guiana, Alaska, Hawaii).
 */
export function mainParts(f: CountryFeature): MultiPolygon {
  const polys: Polygon['coordinates'][] =
    f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const info = polys.map((coordinates) => {
    const poly: Polygon = { type: 'Polygon', coordinates };
    return { coordinates, area: geoArea(poly), centroid: geoCentroid(poly) as LonLat };
  });
  const largest = info.reduce((a, b) => (b.area > a.area ? b : a));
  const keep = info.filter(
    (p) => p === largest || (p.area >= 0.05 * largest.area && geoDistance(p.centroid, largest.centroid) < 30 * RAD),
  );
  return { type: 'MultiPolygon', coordinates: keep.map((p) => p.coordinates) };
}
