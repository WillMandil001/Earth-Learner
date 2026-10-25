import { geoDistance } from 'd3-geo';
import type { GeoProjection } from 'd3-geo';
import { COLORS, LABELS, SMALL_COUNTRY } from '../../config';
import type { CountryMeta, LonLat } from '../../types';
import { compareLabelPriority, isLabelVisibleAtScale, labelFontSize, placeLabels, type Box } from '../labels';
import type { Layer, RenderState } from '../renderer';
import type { CountriesLayer } from './countries';

/** Labels nearer the limb than this (radians from centre) are skipped: too foreshortened. */
const MAX_LABEL_ANGLE = (82 * Math.PI) / 180;

interface Candidate {
  meta: CountryMeta;
  x: number;
  y: number;
  size: number;
  box: Box;
}

export class CountryLabelsLayer implements Layer {
  readonly id = 'labels';
  private ordered: CountryMeta[] | null = null;
  /** Text width at a 100px font, per name. Width scales linearly with font size. */
  private widths = new Map<string, number>();
  private placedCount = 0;

  constructor(private readonly countries: CountriesLayer) {}

  draw(ctx: CanvasRenderingContext2D, projection: GeoProjection, state: RenderState): void {
    this.placedCount = 0;
    if (state.labelMode === 'none') return;
    this.ordered ??= [...state.data.meta.values()].sort(compareLabelPriority);

    const centre: LonLat = [state.camera.lon, state.camera.lat];
    const markerById = new Map(this.countries.markers.filter((m) => m.alpha > 0.5).map((m) => [m.id, m]));
    const candidates: Candidate[] = [];
    for (const meta of this.ordered) {
      if (!isLabelVisibleAtScale(meta, state.radius)) continue;
      if (geoDistance(centre, meta.labelPoint) > MAX_LABEL_ANGLE) continue;
      const p = projection(meta.labelPoint);
      if (!p) continue;
      const size = labelFontSize(meta, state.camera.zoom);
      const w = this.textWidth(ctx, meta.name) * (size / 100) + 2 * LABELS.padding;
      const h = size * 1.2;
      // Labels for marker-sized countries sit just above the marker.
      const y = markerById.has(meta.id) ? p[1] - SMALL_COUNTRY.markerRadius - 2 - h / 2 : p[1];
      candidates.push({ meta, x: p[0], y, size, box: { x: p[0] - w / 2, y: y - h / 2, w, h } });
    }

    const placed = placeLabels(candidates, state.viewport);
    this.placedCount = placed.length;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.labelHalo;
    ctx.fillStyle = COLORS.labelText;
    for (const c of placed) {
      ctx.font = `600 ${c.size.toFixed(1)}px ${LABELS.fontFamily}`;
      ctx.strokeText(c.meta.name, c.x, c.y);
      ctx.fillText(c.meta.name, c.x, c.y);
    }
  }

  private textWidth(ctx: CanvasRenderingContext2D, text: string): number {
    let w = this.widths.get(text);
    if (w === undefined) {
      ctx.font = `600 100px ${LABELS.fontFamily}`;
      w = ctx.measureText(text).width;
      this.widths.set(text, w);
    }
    return w;
  }

  stats() {
    return { labels: this.placedCount };
  }
}
