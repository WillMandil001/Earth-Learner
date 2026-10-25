import type { GeoProjection } from 'd3-geo';
import type { Camera, CountryData, CountryId, HighlightStyle, LabelMode, Lod } from '../types';
import type { Viewport } from './camera';

/** Everything a layer may read for one frame. Layers must not mutate it. */
export interface RenderState {
  readonly camera: Camera;
  readonly viewport: Viewport;
  /** Globe radius in CSS px. */
  readonly radius: number;
  /** Canvas device pixels per CSS px. */
  readonly dpr: number;
  readonly lod: Lod;
  readonly data: CountryData;
  /** Country under the pointer (null if the pointer is over another layer's feature). */
  readonly hovered: CountryId | null;
  /** Topmost feature under the pointer, from any layer. */
  readonly hoveredHit: HitResult | null;
  readonly selected: CountryId | null;
  readonly highlights: ReadonlyMap<CountryId, HighlightStyle>;
  readonly labelMode: LabelMode;
}

export interface HitResult {
  layer: string;
  id: string;
  /** For point features (dots, markers): pixel distance from the pointer. Area hits leave it unset. */
  distancePx?: number;
}

/**
 * A drawable, optionally hit-testable map layer. Future phases (rivers, cities…)
 * add layers via Globe.addLayer without touching existing ones.
 */
export interface Layer {
  readonly id: string;
  /** Derive per-view data (culling, markers…) before draw/hitTest. Called whenever the view changes. */
  prepare?(projection: GeoProjection, state: RenderState): void;
  /** Draw in CSS px; the context is already scaled for devicePixelRatio. */
  draw(ctx: CanvasRenderingContext2D, projection: GeoProjection, state: RenderState): void;
  hitTest?(x: number, y: number, projection: GeoProjection, state: RenderState): HitResult | null;
  /** Numbers for the debug HUD, e.g. visible feature count. */
  stats?(): Record<string, number>;
}

export class Renderer {
  private layers: Layer[] = [];
  /** Per-layer prepare+draw time (ms) of the last frame, for the debug HUD. */
  readonly timings = new Map<string, number>();

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  /** Add a layer on top, or below the layer with id `before`. */
  addLayer(layer: Layer, opts: { before?: string } = {}): void {
    const i = opts.before ? this.layers.findIndex((l) => l.id === opts.before) : -1;
    if (i < 0) this.layers.push(layer);
    else this.layers.splice(i, 0, layer);
  }

  removeLayer(id: string): void {
    this.layers = this.layers.filter((l) => l.id !== id);
  }

  prepare(projection: GeoProjection, state: RenderState): void {
    this.timings.clear();
    for (const l of this.layers) {
      if (!l.prepare) continue;
      const t0 = performance.now();
      l.prepare(projection, state);
      this.timings.set(l.id, performance.now() - t0);
    }
  }

  draw(projection: GeoProjection, state: RenderState, dpr: number): void {
    const { ctx } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, state.viewport.width, state.viewport.height);
    for (const l of this.layers) {
      const t0 = performance.now();
      ctx.save();
      l.draw(ctx, projection, state);
      ctx.restore();
      this.timings.set(l.id, (this.timings.get(l.id) ?? 0) + performance.now() - t0);
    }
  }

  /** Hit-test a single layer. */
  hitTestLayer(id: string, x: number, y: number, projection: GeoProjection, state: RenderState): HitResult | null {
    return this.layers.find((l) => l.id === id)?.hitTest?.(x, y, projection, state) ?? null;
  }

  /**
   * Point features (city dots, small-country markers) beat areas, and among
   * points the nearest to the pointer wins; otherwise the topmost area hit.
   */
  hitTest(x: number, y: number, projection: GeoProjection, state: RenderState): HitResult | null {
    let point: HitResult | null = null;
    let area: HitResult | null = null;
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const hit = this.layers[i]!.hitTest?.(x, y, projection, state);
      if (!hit) continue;
      if (hit.distancePx === undefined) area ??= hit;
      else if (!point || hit.distancePx < point.distancePx!) point = hit;
    }
    return point ?? area;
  }

  stats(): Record<string, number> {
    return Object.assign({}, ...this.layers.map((l) => l.stats?.() ?? {}));
  }
}
