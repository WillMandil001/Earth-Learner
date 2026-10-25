import { geoDistance, geoInterpolate } from 'd3-geo';
import { clampCamera } from './camera';
import type { Camera } from '../types';

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** Default flight duration: 600–1500 ms, growing with angular distance and zoom change. */
export function flightDuration(from: Camera, to: Camera): number {
  const d = geoDistance([from.lon, from.lat], [to.lon, to.lat]);
  const zoomChange = Math.abs(Math.log2(to.zoom / from.zoom));
  return Math.min(1500, Math.max(600, 600 + 900 * (d / Math.PI) + 120 * zoomChange));
}

/**
 * Camera path for a flight. Position follows the great circle; zoom is
 * interpolated in log space and dips out mid-flight on long hops so both ends
 * are briefly in context (subtle Google Earth style).
 */
export function flightPath(from: Camera, to: Camera): (t: number) => Camera {
  const interp = geoInterpolate([from.lon, from.lat], [to.lon, to.lat]);
  const d = geoDistance([from.lon, from.lat], [to.lon, to.lat]);
  // Zoom at which both endpoints would fit in view at once.
  const overviewZoom = d / 2 >= Math.PI / 2 ? 1 : Math.max(1, 1 / Math.sin(d / 2));
  const lz0 = Math.log(from.zoom);
  const lz1 = Math.log(to.zoom);
  const dip = 0.7 * Math.max(0, Math.min(lz0, lz1) - Math.log(overviewZoom));
  return (t) => {
    const e = easeInOutCubic(Math.min(1, Math.max(0, t)));
    const [lon, lat] = interp(e);
    const lz = lz0 + (lz1 - lz0) * e - dip * Math.sin(Math.PI * e);
    return clampCamera({ lon, lat, zoom: Math.exp(lz) });
  };
}
