import { describe, expect, it } from 'vitest';
import { stripSeams } from '../src/data/loadCountries';
import { PALETTE } from '../src/config';
import type { LonLat } from '../src/types';
import { countryData } from './fixtures';

const data = countryData();

describe('country data', () => {
  it('has every country at both levels of detail', () => {
    expect(data.lods.high.features.length).toBe(data.meta.size);
    expect(data.lods.low.features.length).toBe(data.meta.size);
    for (const id of data.meta.keys()) {
      expect(data.lods.low.byId.has(id)).toBe(true);
      expect(data.lods.high.byId.has(id)).toBe(true);
    }
  });

  it('uses ADM0_A3 ids, so France and Norway are present', () => {
    expect(data.meta.get('FRA')?.name).toBe('France');
    expect(data.meta.get('NOR')?.name).toBe('Norway');
  });

  it('gives land neighbours different colours', () => {
    for (const m of data.meta.values()) {
      expect(m.colorIndex).toBeGreaterThanOrEqual(0);
      expect(m.colorIndex).toBeLessThan(PALETTE.length);
      for (const n of m.neighbours) expect(data.meta.get(n)!.colorIndex, `${m.id} vs ${n}`).not.toBe(m.colorIndex);
    }
  });

  it('has symmetric neighbour lists', () => {
    for (const m of data.meta.values()) for (const n of m.neighbours) expect(data.meta.get(n)!.neighbours).toContain(m.id);
    expect(data.meta.get('GBR')!.neighbours).toEqual(['IRL']);
  });
});

describe('stripSeams', () => {
  it('splits lines where they run along the antimeridian', () => {
    const line: LonLat[] = [[170, 60], [180, 62], [180, 66], [175, 67]];
    expect(stripSeams(line)).toEqual([[[170, 60], [180, 62]], [[180, 66], [175, 67]]]);
  });

  it('leaves ordinary lines alone', () => {
    const line: LonLat[] = [[0, 0], [1, 1], [2, 0]];
    expect(stripSeams(line)).toEqual([line]);
  });

  it('removes the Antarctic pole closure from coastlines', () => {
    for (const chunk of data.lods.high.coastlines) {
      const c = chunk.coordinates;
      for (let i = 1; i < c.length; i++) {
        const along180 = Math.abs(Math.abs(c[i]![0]) - 180) < 1e-4 && c[i]![0] === c[i - 1]![0];
        expect(along180).toBe(false);
      }
    }
  });
});
