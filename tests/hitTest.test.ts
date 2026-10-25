import { describe, expect, it } from 'vitest';
import { makeProjection } from '../src/globe/camera';
import { hitTestCountries, hitTestPolygons, inBBox } from '../src/globe/hitTest';
import { computeMarkers } from '../src/globe/markers';
import { SMALL_COUNTRY } from '../src/config';
import type { Camera, LonLat } from '../src/types';
import { countryData } from './fixtures';

const data = countryData();
const features = data.lods.high.features;
const at = (p: LonLat) => hitTestPolygons(p, features, data.meta);

describe('polygon hit-testing (50m)', () => {
  it.each([
    ['London', [-0.12, 51.5], 'GBR'],
    ['Paris', [2.35, 48.86], 'FRA'],
    ['Luxembourg', [6.13, 49.61], 'LUX'],
    ['Singapore', [103.82, 1.35], 'SGP'],
    ['Malta', [14.45, 35.89], 'MLT'],
    ['Bahrain', [50.55, 26.07], 'BHR'],
    ['Nairobi', [36.82, -1.29], 'KEN'],
    ['Wellington', [174.78, -41.29], 'NZL'],
    ['Alaska', [-150, 64], 'USA'],
    ['Chukotka (west of antimeridian)', [-175, 66.5], 'RUS'],
    ['Siberia', [100, 62], 'RUS'],
    ['Fiji, Viti Levu', [178, -17.8], 'FJI'],
    ['Lesotho (enclave in South Africa)', [28.2, -29.6], 'LSO'],
  ] as const)('%s → %s', (_name, p, id) => {
    expect(at([p[0], p[1]])).toBe(id);
  });

  it('returns null over the ocean', () => {
    expect(at([-35, 30])).toBeNull(); // mid-Atlantic
    expect(at([-150, 0])).toBeNull(); // mid-Pacific
  });

  it('handles bounding boxes that cross the antimeridian', () => {
    const rus = data.meta.get('RUS')!;
    expect(rus.bbox[0]).toBeGreaterThan(rus.bbox[2]);
    expect(inBBox([-175, 66], rus.bbox)).toBe(true);
    expect(inBBox([0, 66], rus.bbox)).toBe(false);
  });
});

describe('marker hit-testing', () => {
  const vp = { width: 1000, height: 800 };

  function markerHit(cam: Camera, id: string) {
    const projection = makeProjection(cam, vp);
    const r = (Math.min(vp.width, vp.height) / 2) * 0.95 * cam.zoom;
    const markers = computeMarkers(data.meta.values(), projection, [cam.lon, cam.lat], r, vp);
    const [x, y] = projection(data.meta.get(id)!.labelPoint)!;
    // Click slightly off the marker centre, within the generous hit radius.
    const sx = x + 4;
    const sy = y - 3;
    const geo = projection.invert!([sx, sy]) as LonLat;
    return { markers, hit: hitTestCountries([sx, sy], geo, markers, SMALL_COUNTRY.hitRadius, features, data.meta) };
  }

  it.each(['VAT', 'MCO', 'SMR', 'LIE', 'AND', 'TUV', 'NRU'])('%s is clickable via its marker at globe scale', (id) => {
    const lp = data.meta.get(id)!.labelPoint;
    const { markers, hit } = markerHit({ lon: lp[0] + 20, lat: lp[1] - 10, zoom: 1 }, id);
    expect(markers.some((m) => m.id === id)).toBe(true);
    expect(hit).toBe(id);
  });

  it('large countries do not get markers', () => {
    const { markers } = markerHit({ lon: 10, lat: 45, zoom: 1 }, 'VAT');
    expect(markers.some((m) => ['FRA', 'DEU', 'ITA', 'GBR'].includes(m.id))).toBe(false);
  });

  it('markers fade out once the polygon is large on screen', () => {
    const { markers } = markerHit({ lon: 6.1, lat: 49.7, zoom: 25 }, 'LUX');
    expect(markers.some((m) => m.id === 'LUX')).toBe(false);
  });
});
