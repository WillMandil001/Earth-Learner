import { describe, expect, it } from 'vitest';
import { easeInOutCubic, flightDuration, flightPath } from '../src/globe/animation';

describe('flight', () => {
  const uk = { lon: -2, lat: 54, zoom: 5 };
  const nz = { lon: 172, lat: -41, zoom: 5 };

  it('starts and ends at the requested cameras', () => {
    const path = flightPath(uk, nz);
    expect(path(0).lon).toBeCloseTo(uk.lon, 6);
    expect(path(0).zoom).toBeCloseTo(uk.zoom, 6);
    expect(path(1).lat).toBeCloseTo(nz.lat, 6);
    expect(path(1).zoom).toBeCloseTo(nz.zoom, 6);
  });

  it('zooms out mid-flight on long hops but not on short ones', () => {
    expect(flightPath(uk, nz)(0.5).zoom).toBeLessThan(3);
    const near = { lon: 2, lat: 48, zoom: 5 };
    expect(flightPath(uk, near)(0.5).zoom).toBeCloseTo(5, 1);
  });

  it('scales duration with distance within 600–1500 ms', () => {
    expect(flightDuration(uk, uk)).toBe(600);
    expect(flightDuration(uk, nz)).toBeGreaterThan(1200);
    expect(flightDuration(uk, nz)).toBeLessThanOrEqual(1500);
  });

  it('eases in and out', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBe(0.5);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.1)).toBeLessThan(0.1);
  });
});
