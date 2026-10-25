import { geoDistance } from 'd3-geo';
import type { GeoProjection } from 'd3-geo';
import { COLORS, LABELS } from '../../config';
import type { LabelCandidate, LabelProvider } from '../../globe/layers/labels';
import { MAX_LABEL_ANGLE } from '../../globe/layers/labels';
import type { HitResult, Layer, RenderState } from '../../globe/renderer';
import type { LonLat } from '../../types';
import type { CityRecord, CityTier } from './tiers';

/** 'explore' = dots + labels by zoom; 'dots' = dots only (quiz); 'hidden' = nothing. */
export type CityRenderMode = 'explore' | 'dots' | 'hidden';

export interface RenderCity {
  rec: CityRecord;
  tier: CityTier;
  /** In the home country: shown one zoom step earlier. */
  home: boolean;
}

/** Zoom at which each tier appears; home-country cities one zoom step (×1.5) earlier. */
export const TIER_MIN_ZOOM: Record<CityTier, number> = { capital: 1.5, major: 3, extended: 6 };
const HOME_ZOOM_FACTOR = 1.5;
const TIER_ORDER: Record<CityTier, number> = { capital: 0, major: 1, extended: 2 };
const HIT_RADIUS = 7;
const LABEL_SIZE: Record<CityTier, number> = { capital: 12, major: 11, extended: 10 };

/** City dots (capitals ringed) with zoom-dependent density, and their labels. */
export class CityRenderLayer implements Layer, LabelProvider {
  readonly id = 'cities';
  /** Explore toggle (layers panel). */
  visible = true;
  mode: CityRenderMode = 'explore';
  selected: string | null = null;
  /** In 'dots' mode: the cities shown, as plain unnamed dots, at every zoom. */
  private quizDots: ReadonlySet<string> = new Set();
  /** Countries whose cities are left out this frame (e.g. those drawn as small-country markers). Called once per frame. */
  skipCountries: (() => ReadonlySet<string>) | null = null;
  private cities: RenderCity[] = [];
  private shown: { c: RenderCity; x: number; y: number }[] = [];

  /** Quiz "Find it" with dots: show exactly these cities, all alike, with no names. */
  showQuizDots(ids: Iterable<string>): void {
    this.quizDots = new Set(ids);
    this.mode = 'dots';
  }

  /** Replace the drawn set (after tier settings or the home country change). */
  setCities(cities: RenderCity[]): void {
    this.cities = [...cities].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.rec.p - a.rec.p);
  }

  prepare(projection: GeoProjection, state: RenderState): void {
    this.shown = [];
    if (!this.visible || this.mode === 'hidden') return;
    const centre: LonLat = [state.camera.lon, state.camera.lat];
    const { width, height } = state.viewport;
    const dots = this.mode === 'dots';
    const skip = dots ? null : this.skipCountries?.();
    for (const c of this.cities) {
      if (dots) {
        if (!this.quizDots.has(c.rec.i)) continue;
      } else {
        if (skip?.has(c.rec.c)) continue;
        const minZoom = TIER_MIN_ZOOM[c.tier] / (c.home ? HOME_ZOOM_FACTOR : 1);
        if (state.camera.zoom < minZoom) continue;
      }
      const ll: LonLat = [c.rec.lon, c.rec.lat];
      if (geoDistance(centre, ll) > MAX_LABEL_ANGLE) continue;
      const p = projection(ll);
      if (!p || p[0] < -10 || p[1] < -10 || p[0] > width + 10 || p[1] > height + 10) continue;
      this.shown.push({ c, x: p[0], y: p[1] });
    }
  }

  draw(ctx: CanvasRenderingContext2D, _projection: GeoProjection, state: RenderState): void {
    const hovered = state.hoveredHit?.layer === this.id ? state.hoveredHit.id : null;
    for (const { c, x, y } of this.shown) {
      const strong = c.rec.i === hovered || c.rec.i === this.selected;
      // In quiz dots mode every city looks the same (no capital rings giving hints).
      const plain = this.mode === 'dots';
      const r = plain ? 2.6 + (strong ? 1.4 : 0) : (c.tier === 'extended' ? 1.8 : c.tier === 'major' ? 2.6 : 2.2) + (strong ? 1.2 : 0);
      ctx.fillStyle = c.rec.i === this.selected ? COLORS.selectedOutline : COLORS.labelText;
      ctx.strokeStyle = COLORS.labelHalo;
      ctx.lineWidth = 1.2;
      if (c.tier === 'capital' && !plain) {
        ctx.beginPath();
        ctx.arc(x, y, r + 2.6, 0, 2 * Math.PI);
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = ctx.fillStyle;
        ctx.stroke();
        ctx.strokeStyle = COLORS.labelHalo;
        ctx.lineWidth = 1.2;
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
    }
  }

  hitTest(x: number, y: number): HitResult | null {
    let best: string | null = null;
    let bestD = HIT_RADIUS;
    for (const s of this.shown) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d <= bestD) {
        bestD = d;
        best = s.c.rec.i;
      }
    }
    return best ? { layer: this.id, id: best, distancePx: bestD } : null;
  }

  labelCandidates(_projection: GeoProjection, state: RenderState, measure: (text: string, weight: 400 | 600) => number): LabelCandidate[] {
    if (this.mode !== 'explore') return [];
    const grow = 1 + 0.08 * Math.log2(Math.max(1, state.camera.zoom / 3));
    return this.shown.map(({ c, x, y }) => {
      const size = Math.min(LABELS.maxFontSize - 2, LABEL_SIZE[c.tier] * grow);
      const weight = c.tier === 'capital' ? 600 : 400;
      const w = measure(c.rec.n, weight) * (size / 100) + 2 * LABELS.padding;
      const h = size * 1.2;
      const lx = x + 6;
      return { text: c.rec.n, x: lx, y, size, weight, align: 'left', box: { x: lx - LABELS.padding, y: y - h / 2, w, h } };
    });
  }

  stats() {
    return { cities: this.shown.length };
  }
}
