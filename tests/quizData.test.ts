import { geoContains } from 'd3-geo';
import { describe, expect, it } from 'vitest';
import { resolveClick } from '../src/quiz/data';
import { countryData, quizData } from './fixtures';

const data = quizData();
const countries = countryData();
const scope = data.scopes.sovereign;

describe('quiz scope', () => {
  it('has 197 entries, each a real feature with a display name', () => {
    expect(scope).toHaveLength(197);
    expect(new Set(scope).size).toBe(197);
    for (const id of scope) {
      expect(countries.meta.has(id), id).toBe(true);
      expect(data.names[id]?.display, id).toBeTruthy();
    }
    for (const id of ['VAT', 'PSX', 'TWN', 'KOS', 'SDS', 'FRA', 'NOR']) expect(scope).toContain(id);
    for (const id of ['GRL', 'PRI', 'SAH', 'ATA', 'SOL']) expect(scope).not.toContain(id);
  });

  it('resolves clicks through scoring merges', () => {
    expect(resolveClick(data, 'sovereign', 'SOL')).toBe('SOM');
    expect(resolveClick(data, 'sovereign', 'CYN')).toBe('CYP');
    expect(resolveClick(data, 'sovereign', 'FRA')).toBe('FRA');
    expect(resolveClick(data, 'sovereign', 'SAH')).toBeNull();
    expect(resolveClick(data, 'sovereign', 'GRL')).toBeNull();
    expect(resolveClick(data, 'sovereign', null)).toBeNull();
    for (const [from, to] of Object.entries(data.merges)) {
      expect(scope).not.toContain(from);
      expect(scope).toContain(to);
    }
  });
});

describe('distance matrix', () => {
  it('is symmetric with a zero diagonal', () => {
    for (const a of scope) {
      expect(data.distances.get(a, a)).toBe(0);
      for (const b of scope) expect(data.distances.get(a, b)).toBe(data.distances.get(b, a));
    }
  });

  it('is zero for land neighbours and enclaves, positive across the sea', () => {
    for (const a of scope) {
      for (const b of countries.meta.get(a)!.neighbours) if (data.distances.has(b)) expect(data.distances.get(a, b), `${a}-${b}`).toBe(0);
    }
    expect(data.distances.get('ITA', 'VAT')).toBe(0);
    expect(data.distances.get('ZAF', 'LSO')).toBe(0);
    expect(data.distances.get('GBR', 'FRA')).toBeGreaterThan(20);
    expect(data.distances.get('GBR', 'FRA')).toBeLessThan(60);
    expect(data.distances.get('GBR', 'NZL')).toBeGreaterThan(15000);
  });
});

describe('label anchors', () => {
  it('lie inside their country', () => {
    for (const f of countries.lods.high.features) {
      expect(geoContains(f, countries.meta.get(f.id)!.labelPoint), f.id).toBe(true);
    }
  });
});
