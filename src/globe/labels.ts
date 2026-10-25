import { LABELS } from '../config';
import type { CountryMeta } from '../types';
import type { Viewport } from './camera';

/** Axis-aligned box in CSS px (top-left origin). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Greedy placement: candidates must already be in priority order. A label is
 * kept if it lies fully inside the viewport and overlaps no kept label.
 */
export function placeLabels<T extends { box: Box }>(candidates: readonly T[], vp: Viewport): T[] {
  const placed: T[] = [];
  for (const c of candidates) {
    const b = c.box;
    if (b.x < 0 || b.y < 0 || b.x + b.w > vp.width || b.y + b.h > vp.height) continue;
    if (placed.some((p) => boxesOverlap(p.box, b))) continue;
    placed.push(c);
  }
  return placed;
}

/** Most important first: NE LABELRANK, then MIN_LABEL, then population. */
export function compareLabelPriority(a: CountryMeta, b: CountryMeta): number {
  return a.labelRank - b.labelRank || a.minLabel - b.minLabel || b.popEst - a.popEst;
}

/**
 * Equivalent web-map (256 px tile) zoom for a globe of radius `r` CSS px, so
 * NE's MIN_LABEL, which is expressed in web-map zoom levels, can be used directly.
 */
export function webMapZoom(r: number): number {
  return Math.log2((2 * Math.PI * r) / 256);
}

export function isLabelVisibleAtScale(m: CountryMeta, r: number): boolean {
  return m.minLabel <= webMapZoom(r) + LABELS.zoomBias;
}

/** Larger type for higher-ranked countries, growing gently with zoom. */
export function labelFontSize(m: CountryMeta, zoom: number): number {
  const base = m.labelRank <= 2 ? 14 : m.labelRank <= 4 ? 12.5 : 11;
  const size = base * (1 + 0.12 * Math.log2(zoom));
  return Math.min(LABELS.maxFontSize, Math.max(LABELS.minFontSize, size));
}
