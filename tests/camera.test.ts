import { describe, expect, it } from 'vitest';
import {
  baseRadius,
  clampCamera,
  makeProjection,
  panByPixels,
  screenToLonLat,
  solveCentreForAnchor,
  wrapLon,
  zoomAtPoint,
} from '../src/globe/camera';
import { ZOOM_LIMITS } from '../src/config';
import type { Camera } from '../src/types';

const vp = { width: 1200, height: 800 };

describe('clampCamera', () => {
  it('clamps latitude and zoom and wraps longitude', () => {
    expect(clampCamera({ lon: 190, lat: 95, zoom: 100 })).toEqual({ lon: -170, lat: 90, zoom: ZOOM_LIMITS.max });
    expect(clampCamera({ lon: -540, lat: -120, zoom: 0.1 })).toEqual({ lon: -180, lat: -90, zoom: ZOOM_LIMITS.min });
    expect(clampCamera({ lon: 10, lat: 20, zoom: 3 })).toEqual({ lon: 10, lat: 20, zoom: 3 });
  });

  it('wrapLon keeps values in [-180, 180)', () => {
    for (const lon of [-721, -180, 0, 179.9, 180, 359, 1000]) {
      const w = wrapLon(lon);
      expect(w).toBeGreaterThanOrEqual(-180);
      expect(w).toBeLessThan(180);
    }
  });
});

describe('panByPixels', () => {
  it('moves the surface at the view centre by the drag distance', () => {
    const cam: Camera = { lon: 0, lat: 0, zoom: 2 };
    const r = baseRadius(vp) * cam.zoom;
    const next = panByPixels(cam, 100, 0, vp);
    expect(next.lon).toBeCloseTo((-100 / r) * (180 / Math.PI), 9);
    expect(next.lat).toBe(0);
  });

  it('never rolls past the poles', () => {
    expect(panByPixels({ lon: 0, lat: 85, zoom: 1 }, 0, 10_000, vp).lat).toBe(90);
    expect(panByPixels({ lon: 0, lat: -85, zoom: 1 }, 0, -10_000, vp).lat).toBe(-90);
  });
});

describe('solveCentreForAnchor', () => {
  it('centres on the point when the offset is zero', () => {
    const c = solveCentreForAnchor([33, -12], 0, 0, 500, [0, 0])!;
    expect(c[0]).toBeCloseTo(33, 9);
    expect(c[1]).toBeCloseTo(-12, 9);
  });
});

describe('zoom toward cursor', () => {
  // Deterministic pseudo-random sweep over cameras, cursors and zoom steps.
  let seed = 42;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  it('keeps the geographic point under the cursor within 0.5 px', () => {
    let checked = 0;
    for (let i = 0; i < 500; i++) {
      const cam = clampCamera({ lon: rand() * 360 - 180, lat: rand() * 140 - 70, zoom: 1 + rand() * 10 });
      const x = rand() * vp.width;
      const y = rand() * vp.height;
      const geo = screenToLonLat(cam, vp, x, y);
      if (!geo) continue;
      const zoom = cam.zoom * (0.6 + rand() * 1.2);
      const next = zoomAtPoint(cam, zoom, x, y, vp);
      // Zooming out can make the anchor unreachable without roll; then zoom simply about the centre.
      if (next.lon === cam.lon && next.lat === cam.lat) continue;
      const [px, py] = makeProjection(next, vp)(geo)!;
      expect(Math.hypot(px - x, py - y)).toBeLessThan(0.5);
      expect(next.zoom).toBeCloseTo(Math.min(ZOOM_LIMITS.max, Math.max(ZOOM_LIMITS.min, zoom)), 9);
      checked++;
    }
    expect(checked).toBeGreaterThan(250);
  });

  it('respects zoom limits', () => {
    const cam: Camera = { lon: 0, lat: 0, zoom: 20 };
    expect(zoomAtPoint(cam, 1000, 600, 400, vp).zoom).toBe(ZOOM_LIMITS.max);
    expect(zoomAtPoint(cam, 0.01, 600, 400, vp).zoom).toBe(ZOOM_LIMITS.min);
  });
});
