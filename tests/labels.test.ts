import { describe, expect, it } from 'vitest';
import { boxesOverlap, compareLabelPriority, placeLabels } from '../src/globe/labels';
import { countryData } from './fixtures';

const vp = { width: 400, height: 300 };
const label = (name: string, x: number, y: number, w = 40, h = 12) => ({ name, box: { x, y, w, h } });

describe('boxesOverlap', () => {
  it('detects overlap and treats touching edges as clear', () => {
    expect(boxesOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(boxesOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
    expect(boxesOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 20, w: 10, h: 10 })).toBe(false);
  });
});

describe('placeLabels', () => {
  it('keeps higher-priority labels and drops overlapping or off-screen ones', () => {
    const placed = placeLabels(
      [
        label('first', 100, 100),
        label('overlaps first', 120, 105),
        label('clear', 200, 100),
        label('off screen', 380, 100),
        label('also clear', 100, 150),
      ],
      vp,
    );
    expect(placed.map((p) => p.name)).toEqual(['first', 'clear', 'also clear']);
  });

  it('never returns overlapping boxes', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const many = Array.from({ length: 300 }, (_, i) => label(String(i), rand() * 360, rand() * 280, 20 + rand() * 40));
    const placed = placeLabels(many, vp);
    for (const a of placed) for (const b of placed) if (a !== b) expect(boxesOverlap(a.box, b.box)).toBe(false);
  });
});

describe('compareLabelPriority', () => {
  it('ranks big countries before microstates', () => {
    const meta = countryData().meta;
    const order = ['VAT', 'RUS', 'FRA', 'LUX'].map((id) => meta.get(id)!).sort(compareLabelPriority);
    expect(order[0]!.id).toBe('RUS');
    expect(order[order.length - 1]!.id).not.toBe('RUS');
    expect(order.findIndex((m) => m.id === 'FRA')).toBeLessThan(order.findIndex((m) => m.id === 'VAT'));
  });
});
