import { geoDistance } from 'd3-geo';
import type { GeoProjection } from 'd3-geo';
import { COLORS, LABELS, SMALL_COUNTRY } from '../../config';
import type { CountryMeta, LonLat } from '../../types';
import { compareLabelPriority, isLabelVisibleAtScale, labelFontSize, placeLabels, type Box } from '../labels';
import type { Layer, RenderState } from '../renderer';
import type { CountriesLayer } from './countries';

/** Labels nearer the limb than this (radians from centre) are skipped: too foreshortened. */
export const MAX_LABEL_ANGLE = (82 * Math.PI) / 180;
/** Above this zoom, provider labels (cities) take priority over country labels. */
const PROVIDERS_FIRST_ZOOM = 4;

export interface LabelCandidate {
  text: string;
  /** Anchor point (CSS px). With align 'left' the text starts at x. */
  x: number;
  y: number;
  size: number;
  weight: 400 | 600;
  align: 'center' | 'left';
  color?: string;
  box: Box;
}

/** Another layer's labels, in that layer's own priority order. */
export interface LabelProvider {
  labelCandidates(projection: GeoProjection, state: RenderState, measure: (text: string, weight: 400 | 600) => number): LabelCandidate[];
}

/**
 * All map labels, placed together so none overlap: country labels (when the
 * label mode is 'all') plus any providers' labels (cities…). Country labels win
 * at low zoom; providers win once zoomed in.
 */
export class LabelsLayer implements Layer {
  readonly id = 'labels';
  private ordered: CountryMeta[] | null = null;
  /** Text width at a 100px font, per weight + text. Width scales linearly with font size. */
  private widths = new Map<string, number>();
  private placedCount = 0;
  private providers: LabelProvider[] = [];

  constructor(private readonly countries: CountriesLayer) {}

  addProvider(p: LabelProvider): void {
    this.providers.push(p);
  }

  draw(ctx: CanvasRenderingContext2D, projection: GeoProjection, state: RenderState): void {
    const measure = (text: string, weight: 400 | 600) => this.textWidth(ctx, text, weight);
    const countryLabels = state.labelMode === 'all' ? this.countryCandidates(projection, state, measure) : [];
    const others = this.providers.flatMap((p) => p.labelCandidates(projection, state, measure));
    const ordered = state.camera.zoom < PROVIDERS_FIRST_ZOOM ? [...countryLabels, ...others] : [...others, ...countryLabels];
    const placed = placeLabels(ordered, state.viewport);
    this.placedCount = placed.length;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.labelHalo;
    for (const c of placed) {
      ctx.font = `${c.weight} ${c.size.toFixed(1)}px ${LABELS.fontFamily}`;
      ctx.textAlign = c.align;
      ctx.fillStyle = c.color ?? COLORS.labelText;
      ctx.strokeText(c.text, c.x, c.y);
      ctx.fillText(c.text, c.x, c.y);
    }
  }

  private countryCandidates(
    projection: GeoProjection,
    state: RenderState,
    measure: (text: string, weight: 400 | 600) => number,
  ): LabelCandidate[] {
    this.ordered ??= [...state.data.meta.values()].sort(compareLabelPriority);
    const centre: LonLat = [state.camera.lon, state.camera.lat];
    const markerById = new Map(this.countries.markers.filter((m) => m.alpha > 0.5).map((m) => [m.id, m]));
    const out: LabelCandidate[] = [];
    for (const meta of this.ordered) {
      if (!isLabelVisibleAtScale(meta, state.radius)) continue;
      if (geoDistance(centre, meta.labelPoint) > MAX_LABEL_ANGLE) continue;
      const p = projection(meta.labelPoint);
      if (!p) continue;
      const size = labelFontSize(meta, state.camera.zoom);
      const w = measure(meta.name, 600) * (size / 100) + 2 * LABELS.padding;
      const h = size * 1.2;
      // Labels for marker-sized countries sit just above the marker.
      const y = markerById.has(meta.id) ? p[1] - SMALL_COUNTRY.markerRadius - 2 - h / 2 : p[1];
      out.push({ text: meta.name, x: p[0], y, size, weight: 600, align: 'center', box: { x: p[0] - w / 2, y: y - h / 2, w, h } });
    }
    return out;
  }

  private textWidth(ctx: CanvasRenderingContext2D, text: string, weight: 400 | 600): number {
    const key = `${weight}|${text}`;
    let w = this.widths.get(key);
    if (w === undefined) {
      ctx.font = `${weight} 100px ${LABELS.fontFamily}`;
      w = ctx.measureText(text).width;
      this.widths.set(key, w);
    }
    return w;
  }

  stats() {
    return { labels: this.placedCount };
  }
}
