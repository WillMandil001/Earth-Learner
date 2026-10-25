import { geoDistance } from 'd3-geo';
import type { GeoProjection } from 'd3-geo';
import { COLORS, HIGHLIGHT_STYLES, PALETTE, SMALL_COUNTRY } from '../../config';
import type { CountryFeature, CountryId, CountryMeta, LonLat, MeshChunk } from '../../types';
import { mix } from '../color';
import { FastOrtho } from '../fastOrtho';
import { hitTestCountries, type Marker } from '../hitTest';
import { computeMarkers } from '../markers';
import type { Layer, RenderState } from '../renderer';

const RAD = Math.PI / 180;
/** Skip vertices closer than this many device pixels to the previous one. */
const MIN_SEGMENT_DEVICE_PX = 0.75;

/**
 * Angular radius (radians) around the view centre that can appear on screen:
 * a full hemisphere when the globe fits, less when zoomed past the viewport.
 */
export function visibleReach(state: RenderState): number {
  const corner = Math.hypot(state.viewport.width, state.viewport.height) / 2;
  return corner >= state.radius ? Math.PI / 2 : Math.asin(corner / state.radius) + 0.01;
}

/** 'out' = entirely beyond reach, 'front' = entirely on the near hemisphere (no clipping needed), else 'clip'. */
export function classifyCap(cap: readonly [number, number, number], centre: LonLat, reach: number): 'out' | 'front' | 'clip' {
  const d = geoDistance(centre, [cap[0], cap[1]]);
  const r = cap[2] * RAD;
  if (d - r >= reach) return 'out';
  return d + r < Math.PI / 2 - 1e-3 ? 'front' : 'clip';
}

interface CulledMesh {
  front: MeshChunk[];
  /** Chunks crossing the horizon. */
  clipped: MeshChunk[];
}

function cullMesh(chunks: MeshChunk[], centre: LonLat, reach: number): CulledMesh {
  const mesh: CulledMesh = { front: [], clipped: [] };
  for (const c of chunks) {
    const cls = classifyCap(c.cap, centre, reach);
    if (cls !== 'out') mesh[cls === 'front' ? 'front' : 'clipped'].push(c);
  }
  return mesh;
}

const EMPTY_MESH: CulledMesh = { front: [], clipped: [] };

export class CountriesLayer implements Layer {
  readonly id = 'countries';
  visible: CountryFeature[] = [];
  markers: Marker[] = [];
  /** Visible features that straddle the horizon or the viewport edge; their polygons are classified individually. */
  private clipped = new Set<CountryId>();
  private borders = EMPTY_MESH;
  private coastlines = EMPTY_MESH;
  private readonly fast = new FastOrtho();

  prepare(projection: GeoProjection, state: RenderState): void {
    const { data } = state;
    const geom = data.lods[state.lod];
    const centre: LonLat = [state.camera.lon, state.camera.lat];
    const reach = visibleReach(state);
    this.visible = [];
    this.clipped = new Set();
    for (const f of geom.features) {
      const m = data.meta.get(f.id);
      const cls = m ? classifyCap(m.cap, centre, reach) : 'clip';
      if (cls === 'out') continue;
      this.visible.push(f);
      if (cls === 'clip') this.clipped.add(f.id);
    }
    this.borders = cullMesh(geom.borders, centre, reach);
    this.coastlines = cullMesh(geom.coastlines, centre, reach);
    const metas = this.visible.map((f) => data.meta.get(f.id)).filter((m): m is CountryMeta => !!m);
    this.markers = computeMarkers(metas, projection, centre, state.radius, state.viewport);
  }

  draw(ctx: CanvasRenderingContext2D, _projection: GeoProjection, state: RenderState): void {
    const fast = this.fast.set(state.camera, state.viewport);
    const minSeg = MIN_SEGMENT_DEVICE_PX / state.dpr;
    const parts = state.data.lods[state.lod].parts;
    const centre: LonLat = [state.camera.lon, state.camera.lat];
    const reach = visibleReach(state);
    const zoomWidth = 1 + 0.15 * Math.log2(state.camera.zoom);

    // Fills, batched into one path per colour.
    const groups = new Map<string, CountryFeature[]>();
    for (const f of this.visible) {
      const fill = this.fillFor(f.id, state);
      const g = groups.get(fill);
      if (g) g.push(f);
      else groups.set(fill, [f]);
    }
    for (const [fill, features] of groups) {
      ctx.beginPath();
      for (const f of features) {
        const whole = !this.clipped.has(f.id);
        for (const part of parts.get(f.id) ?? []) {
          const cls = whole ? 'front' : classifyCap(part.cap, centre, reach);
          if (cls !== 'out') fast.draw(ctx, part.packed, true, minSeg, cls === 'clip');
        }
      }
      ctx.fillStyle = fill;
      ctx.fill();
    }

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const strokeMesh = (mesh: CulledMesh, style: string, width: number) => {
      ctx.beginPath();
      for (const c of mesh.front) fast.draw(ctx, c.packed, false, minSeg);
      for (const c of mesh.clipped) fast.draw(ctx, c.packed, false, minSeg, true);
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    strokeMesh(this.borders, COLORS.border, 0.6 * zoomWidth);
    strokeMesh(this.coastlines, COLORS.coastline, 0.9 * zoomWidth);

    const visibleIds = new Set(this.visible.map((f) => f.id));
    const outline = (id: CountryId, stroke: string, width: number) => {
      const rings = visibleIds.has(id) ? state.data.outline(id, state.lod) : null;
      if (!rings) return;
      ctx.beginPath();
      fast.draw(ctx, rings, false, minSeg, true);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    for (const [id, style] of state.highlights) {
      const s = HIGHLIGHT_STYLES[style];
      if (s.stroke) outline(id, s.stroke, s.strokeWidth);
    }
    if (state.selected) outline(state.selected, COLORS.selectedOutline, 2.2);
    if (state.hovered && state.hovered !== state.selected) outline(state.hovered, COLORS.hoverOutline, 1.6);

    this.drawMarkers(ctx, state);
  }

  private drawMarkers(ctx: CanvasRenderingContext2D, state: RenderState): void {
    const r0 = SMALL_COUNTRY.markerRadius;
    // Highlighted (quiz) markers are drawn biggest, in their style's colours.
    const style = (m: Marker) => {
      const hl = state.highlights.get(m.id);
      return hl && HIGHLIGHT_STYLES[hl].stroke ? HIGHLIGHT_STYLES[hl] : null;
    };
    // Draw emphasised markers last so they sit on top of crowded neighbours.
    const emphasised = (m: Marker) => m.id === state.hovered || m.id === state.selected || !!style(m);
    const ordered = [...this.markers.filter((m) => !emphasised(m)), ...this.markers.filter(emphasised)];
    for (const m of ordered) {
      const strong = emphasised(m);
      const hl = style(m);
      ctx.globalAlpha = strong ? 1 : m.alpha;
      ctx.beginPath();
      ctx.arc(m.x, m.y, hl ? r0 + 3 : strong ? r0 + 1.5 : r0, 0, 2 * Math.PI);
      ctx.fillStyle = this.fillFor(m.id, state);
      ctx.fill();
      ctx.lineWidth = hl ? 2.5 : strong ? 2 : 1.2;
      ctx.strokeStyle = hl?.stroke ?? (m.id === state.selected ? COLORS.selectedOutline : COLORS.markerOutline);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private fillFor(id: CountryId, state: RenderState): string {
    const meta = state.data.meta.get(id);
    const hl = state.highlights.get(id);
    let fill: string = hl ? HIGHLIGHT_STYLES[hl].fill : PALETTE[meta?.colorIndex ?? 0] ?? PALETTE[0];
    if (id === state.selected) fill = mix(fill, COLORS.selectedFill, 0.55);
    if (id === state.hovered) fill = mix(fill, '#ffffff', 0.28);
    return fill;
  }

  hitTest(x: number, y: number, projection: GeoProjection, state: RenderState) {
    const geo = projection.invert?.([x, y]) ?? null;
    const onGlobe =
      geo && Number.isFinite(geo[0]) && Math.hypot(x - state.viewport.width / 2, y - state.viewport.height / 2) <= state.radius;
    // Always hit-test against 50m so the result does not depend on the current LOD.
    const id = hitTestCountries(
      [x, y],
      onGlobe ? [geo[0], geo[1]] : null,
      this.markers,
      SMALL_COUNTRY.hitRadius,
      state.data.lods.high.features,
      state.data.meta,
    );
    return id ? { layer: this.id, id } : null;
  }

  stats() {
    return { visibleFeatures: this.visible.length, markers: this.markers.length };
  }
}
