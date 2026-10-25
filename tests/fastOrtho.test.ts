import { describe, expect, it } from 'vitest';
import { makeProjection } from '../src/globe/camera';
import { FastOrtho } from '../src/globe/fastOrtho';
import type { Camera, LonLat } from '../src/types';

describe('FastOrtho', () => {
  it('matches d3.geoOrthographic on the visible hemisphere', () => {
    const vp = { width: 1000, height: 700 };
    const cams: Camera[] = [
      { lon: 0, lat: 0, zoom: 1 },
      { lon: -2, lat: 54, zoom: 6 },
      { lon: 170, lat: -40, zoom: 3 },
      { lon: -100, lat: 89, zoom: 1.5 },
    ];
    for (const cam of cams) {
      const d3p = makeProjection(cam, vp);
      const fast = new FastOrtho().set(cam, vp);
      for (let i = 0; i < 200; i++) {
        // Points within 80° of the centre.
        const p: LonLat = [cam.lon + ((i * 37) % 160) - 80, Math.max(-89, Math.min(89, cam.lat + ((i * 53) % 120) - 60))];
        const a = d3p(p);
        if (!a || Number.isNaN(a[0])) continue;
        const b = fast.project(p);
        expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-6);
      }
    }
  });
});
