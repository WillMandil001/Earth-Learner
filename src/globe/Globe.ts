import { geoDistance, type GeoPermissibleObjects, type GeoProjection } from 'd3-geo';
import { DEVICE_PIXEL_RATIO_CAP, HOME_CONTEXT_FACTOR, HOME_COUNTRY, LOD } from '../config';
import type { Camera, CountryData, CountryId, HighlightStyle, LabelMode, Lod, LonLat } from '../types';
import { flightDuration, flightPath } from './animation';
import {
  clampCamera,
  fitCamera,
  globeRadius,
  mainParts,
  makeProjection,
  screenToLonLat,
  updateProjection,
  type Viewport,
} from './camera';
import { Emitter } from './events';
import { Interaction, type Animator, type InteractionHost } from './interaction';
import { atmosphereLayer, graticuleLayer, limbShadeLayer, oceanLayer } from './layers/base';
import { CountriesLayer } from './layers/countries';
import { LabelsLayer } from './layers/labels';
import { Renderer, type HitResult, type Layer, type RenderState } from './renderer';
import type { LabelProvider } from './layers/labels';

export interface GlobeOptions {
  homeCountry: CountryId;
  /** Initial camera; defaults to the home view. */
  initialCamera: Camera | null;
  labelMode: LabelMode;
  interactive: boolean;
}

export interface GlobePointerEvent {
  /** Country under the pointer (polygon or small-country marker). */
  id: CountryId | null;
  /** Topmost feature under the pointer from any layer (e.g. a city dot above a country). */
  hit: HitResult | null;
  lonLat: LonLat | null;
  /** CSS px relative to the container. */
  x: number;
  y: number;
}

export interface RenderStats {
  /** Time spent preparing and drawing the last frame (ms). */
  frameMs: number;
  /** Frames per second over recent continuous rendering; 0 when idle. */
  fps: number;
  lod: Lod;
  camera: Camera;
  hovered: CountryId | null;
  selected: CountryId | null;
  /** Layer stats, e.g. visibleFeatures, markers, labels. */
  layers: Record<string, number>;
  /** Per-layer prepare+draw time (ms). */
  layerMs: Record<string, number>;
}

export interface GlobeEvents extends Record<string, unknown> {
  hover: GlobePointerEvent;
  click: GlobePointerEvent;
  dblclick: GlobePointerEvent;
  cameraChange: Camera;
  /** Emitted after every frame; for the debug HUD and measurements. */
  render: RenderStats;
}

interface Flight extends Animator {
  resolve(): void;
}

const FPS_GAP_MS = 100;

export class Globe {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: Renderer;
  private readonly labels: LabelsLayer;
  private readonly interaction: Interaction;
  private readonly events = new Emitter<GlobeEvents>();
  private readonly options: GlobeOptions;
  private readonly projection: GeoProjection;
  private readonly resizeObserver: ResizeObserver;
  private camera: Camera;
  private viewport: Viewport = { width: 1, height: 1 };
  private dpr = 1;
  private hovered: HitResult | null = null;
  private selected: CountryId | null = null;
  private highlights = new Map<CountryId, HighlightStyle>();
  private labelMode: LabelMode;
  private interactive: boolean;
  private animators = new Set<Animator>();
  private raf = 0;
  private steppingAnimators = false;
  private idleTimer = 0;
  private lastMotionAt = -Infinity;
  private lastPointer: { x: number; y: number } | null = null;
  /** The view that layers were last prepared for, so hit tests can reuse it. */
  private prepared: RenderState | null = null;
  /** Last measured 50m render time and the zoom it was measured at. */
  private highMs = { ms: 0, zoom: 0 };
  private frameTimes: number[] = [];
  private dprQuery: MediaQueryList | null = null;
  private destroyed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly data: CountryData,
    options: Partial<GlobeOptions> = {},
  ) {
    this.options = { homeCountry: HOME_COUNTRY, initialCamera: null, labelMode: 'all', interactive: true, ...options };
    this.labelMode = this.options.labelMode;
    this.interactive = this.options.interactive;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'globe-canvas';
    this.canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;user-select:none;';
    container.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not supported');

    this.renderer = new Renderer(ctx);
    const countries = new CountriesLayer();
    for (const layer of [atmosphereLayer, oceanLayer, graticuleLayer, countries, limbShadeLayer]) {
      this.renderer.addLayer(layer);
    }
    this.labels = new LabelsLayer(countries);
    this.renderer.addLayer(this.labels);

    this.measure();
    this.camera = this.options.initialCamera ? clampCamera(this.options.initialCamera) : this.homeCamera();
    this.projection = makeProjection(this.camera, this.viewport);

    this.interaction = new Interaction(this.host());
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(container);
    this.watchDpr();
    this.requestRender();
  }

  // ---- Public API ----------------------------------------------------------

  getCamera(): Camera {
    return { ...this.camera };
  }

  setCamera(camera: Partial<Camera>): void {
    this.cancelMotion();
    this.applyCamera({ ...this.camera, ...camera });
  }

  flyTo(target: Partial<Camera>, opts: { duration?: number } = {}): Promise<void> {
    this.cancelMotion();
    const from = this.getCamera();
    const to = clampCamera({ ...from, ...target });
    const duration = opts.duration ?? flightDuration(from, to);
    const path = flightPath(from, to);
    return new Promise((resolve) => {
      let start = -1;
      const flight: Flight = {
        resolve,
        step: (now) => {
          if (start < 0) start = now;
          const t = duration > 0 ? (now - start) / duration : 1;
          this.applyCamera(t >= 1 ? to : path(t));
          if (t >= 1) resolve();
          return t < 1;
        },
        cancel: resolve,
      };
      this.addAnimator(flight);
    });
  }

  /**
   * Fly to frame a country's main landmass. `anchor` centres the view on a given
   * point instead (e.g. the label anchor); `maxZoom` keeps some surrounding context,
   * so microstates are shown as a clear marker among their neighbours.
   */
  flyToCountry(
    id: CountryId,
    opts: { duration?: number; anchor?: LonLat; maxZoom?: number; minZoom?: number; fill?: number } = {},
  ): Promise<void> {
    const f = this.data.lods.high.byId.get(id);
    if (!f) return Promise.resolve();
    return this.flyToFit(mainParts(f), { ...opts, fill: opts.fill ?? 0.7, centre: opts.anchor });
  }

  /** The home view: home country plus its land neighbours, with some context. */
  homeCamera(): Camera {
    const home = this.data.meta.get(this.options.homeCountry);
    const ids = [this.options.homeCountry, ...(home?.neighbours ?? [])];
    const polys = ids.flatMap((id) => {
      const f = this.data.lods.high.byId.get(id);
      return f ? mainParts(f).coordinates : [];
    });
    if (!home || !polys.length) return { lon: 0, lat: 20, zoom: 1 };
    const fit = fitCamera({ type: 'MultiPolygon', coordinates: polys }, this.viewport, {
      centre: home.labelPoint,
      fill: 0.9,
    });
    return clampCamera({ ...fit, zoom: fit.zoom * HOME_CONTEXT_FACTOR });
  }

  setHomeCountry(id: CountryId): void {
    this.options.homeCountry = id;
  }

  flyHome(opts: { duration?: number } = {}): Promise<void> {
    return this.flyTo(this.homeCamera(), opts);
  }

  setHighlights(map: Record<CountryId, HighlightStyle>): void {
    this.highlights = new Map(Object.entries(map));
    this.invalidate();
  }

  clearHighlights(): void {
    this.highlights = new Map();
    this.invalidate();
  }

  setSelected(id: CountryId | null): void {
    if (id === this.selected) return;
    this.selected = id;
    this.invalidate();
  }

  getSelected(): CountryId | null {
    return this.selected;
  }

  setLabelMode(mode: LabelMode): void {
    this.labelMode = mode;
    this.invalidate();
  }

  getLabelMode(): LabelMode {
    return this.labelMode;
  }

  setInteractive(enabled: boolean): void {
    this.interactive = enabled;
    if (!enabled) this.setHovered(null, null);
  }

  on<K extends keyof GlobeEvents>(event: K, handler: (payload: GlobeEvents[K]) => void): () => void {
    return this.events.on(event, handler);
  }

  /** Register an extra map layer (rivers, cities…), on top or below layer `before`. */
  addLayer(layer: Layer, opts: { before?: string } = {}): void {
    this.renderer.addLayer(layer, opts);
    this.invalidate();
  }

  removeLayer(id: string): void {
    this.renderer.removeLayer(id);
    this.invalidate();
  }

  /** Screen position (CSS px, container-relative) of a point, or null if it is on the far side. */
  project(lonLat: LonLat): [number, number] | null {
    if (geoDistance([this.camera.lon, this.camera.lat], lonLat) > Math.PI / 2) return null;
    const p = updateProjection(this.projection, this.camera, this.viewport)(lonLat);
    return p ? [p[0], p[1]] : null;
  }

  /** Redraw after an added layer's own state changed. */
  redraw(): void {
    this.invalidate();
  }

  /** Country under a container-relative point (markers first), ignoring other layers. */
  hitTest(x: number, y: number): CountryId | null {
    const state = this.prepared ?? this.prepare(this.chooseLod());
    return this.renderer.hitTestLayer('countries', x, y, this.projection, state)?.id ?? null;
  }

  /** Topmost feature (any layer) under a container-relative point. */
  hitTestTop(x: number, y: number): HitResult | null {
    const state = this.prepared ?? this.prepare(this.chooseLod());
    return this.renderer.hitTest(x, y, this.projection, state);
  }

  /** Add labels from another layer (e.g. cities) to the shared collision-avoiding placement. */
  addLabelProvider(provider: LabelProvider): void {
    this.labels.addProvider(provider);
    this.invalidate();
  }

  /**
   * Fly to frame any geometry (e.g. a city and a click). `centre` keeps that point
   * in the middle; zoom is clamped to [minZoom, maxZoom].
   */
  flyToFit(
    geom: GeoPermissibleObjects,
    opts: { centre?: LonLat; fill?: number; minZoom?: number; maxZoom?: number; duration?: number } = {},
  ): Promise<void> {
    const fit = fitCamera(geom, this.viewport, { fill: opts.fill ?? 0.7, centre: opts.centre });
    const zoom = Math.max(opts.minZoom ?? 0, Math.min(fit.zoom, opts.maxZoom ?? Infinity));
    return this.flyTo({ ...fit, zoom }, { duration: opts.duration });
  }

  destroy(): void {
    this.destroyed = true;
    this.cancelMotion();
    cancelAnimationFrame(this.raf);
    clearTimeout(this.idleTimer);
    this.interaction.destroy();
    this.resizeObserver.disconnect();
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.events.clear();
    this.canvas.remove();
  }

  // ---- Internals -----------------------------------------------------------

  private host(): InteractionHost {
    return {
      element: this.canvas,
      isEnabled: () => this.interactive,
      getCamera: () => this.camera,
      getViewport: () => this.viewport,
      moveCamera: (cam) => this.applyCamera(cam),
      addAnimator: (a) => this.addAnimator(a),
      cancelMotion: () => this.cancelMotion(),
      zoomBy: (factor) => void this.flyTo({ zoom: this.camera.zoom * factor }, { duration: 250 }),
      pointerHover: (x, y) => {
        this.lastPointer = { x, y };
        if (!this.interaction.dragging) this.setHovered(this.hitTestTop(x, y), { x, y });
      },
      pointerLeave: () => {
        this.lastPointer = null;
        this.setHovered(null, null);
      },
      pointerTap: (x, y, kind) => {
        this.events.emit(kind, this.pointerEvent(this.hitTestTop(x, y), x, y));
      },
      dragStateChanged: (dragging) => {
        if (dragging) this.setHovered(null, null);
        this.canvas.style.cursor = dragging ? 'grabbing' : '';
      },
    };
  }

  private pointerEvent(hit: HitResult | null, x: number, y: number): GlobePointerEvent {
    const id = hit?.layer === 'countries' ? hit.id : hit ? this.hitTest(x, y) : null;
    return { id, hit, x, y, lonLat: screenToLonLat(this.camera, this.viewport, x, y) };
  }

  private setHovered(hit: HitResult | null, at: { x: number; y: number } | null): void {
    const changed = hit?.layer !== this.hovered?.layer || hit?.id !== this.hovered?.id;
    this.hovered = hit;
    if (changed) {
      this.canvas.style.cursor = hit ? 'pointer' : '';
      this.invalidate();
    }
    if (changed || hit) this.events.emit('hover', this.pointerEvent(hit, at?.x ?? 0, at?.y ?? 0));
  }

  private applyCamera(cam: Camera): void {
    const next = clampCamera(cam);
    const c = this.camera;
    if (next.lon === c.lon && next.lat === c.lat && next.zoom === c.zoom) return;
    this.camera = next;
    this.lastMotionAt = performance.now();
    this.invalidate();
    this.events.emit('cameraChange', this.getCamera());
  }

  private addAnimator(a: Animator): void {
    this.animators.add(a);
    this.requestRender();
  }

  private cancelMotion(): boolean {
    const all = [...this.animators];
    this.animators.clear();
    all.forEach((a) => a.cancel?.());
    return all.length > 0;
  }

  private invalidate(): void {
    this.prepared = null;
    this.requestRender();
  }

  private requestRender(): void {
    if (!this.raf && !this.steppingAnimators && !this.destroyed) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    // Animators move the camera; this frame renders the result, so don't queue another.
    this.steppingAnimators = true;
    for (const a of [...this.animators]) if (!a.step(now)) this.animators.delete(a);
    this.steppingAnimators = false;
    this.render(now);
    if (this.animators.size) this.requestRender();
  };

  private isMoving(): boolean {
    return (
      this.animators.size > 0 ||
      this.interaction.dragging ||
      performance.now() - this.lastMotionAt < LOD.idleDelayMs
    );
  }

  /**
   * 110m while moving, 50m when idle. When zoomed in, 50m is also used during
   * motion if its last measured render time (near this zoom) fits the budget;
   * a stale measurement is refreshed by trying a 50m frame.
   */
  private chooseLod(): Lod {
    if (!this.isMoving()) return 'high';
    if (this.camera.zoom < LOD.highDuringMotionZoom) return 'low';
    const stale = Math.abs(Math.log2(this.camera.zoom / this.highMs.zoom)) > 0.5;
    return stale || this.highMs.ms <= LOD.motionFrameBudgetMs ? 'high' : 'low';
  }

  private prepare(lod: Lod): RenderState {
    updateProjection(this.projection, this.camera, this.viewport);
    const state: RenderState = {
      camera: this.camera,
      viewport: this.viewport,
      radius: globeRadius(this.camera, this.viewport),
      dpr: this.dpr,
      lod,
      data: this.data,
      hovered: this.hovered?.layer === 'countries' ? this.hovered.id : null,
      hoveredHit: this.hovered,
      selected: this.selected,
      highlights: this.highlights,
      labelMode: this.labelMode,
    };
    this.renderer.prepare(this.projection, state);
    this.prepared = state;
    return state;
  }

  private render(now: number): void {
    const lod = this.chooseLod();
    const t0 = performance.now();
    const state = this.prepared?.lod === lod ? this.prepared : this.prepare(lod);
    this.renderer.draw(this.projection, state, this.dpr);
    const frameMs = performance.now() - t0;
    if (lod === 'high') this.highMs = { ms: frameMs, zoom: this.camera.zoom };

    const prev = this.frameTimes[this.frameTimes.length - 1];
    if (prev === undefined || now - prev > FPS_GAP_MS) this.frameTimes = [];
    this.frameTimes.push(now);
    if (this.frameTimes.length > 30) this.frameTimes.shift();

    if (this.isMoving() && lod === 'low') this.scheduleIdleRender();

    if (this.events.hasListeners('render')) {
      const n = this.frameTimes.length;
      const span = n > 1 ? this.frameTimes[n - 1]! - this.frameTimes[0]! : 0;
      this.events.emit('render', {
        frameMs,
        fps: span > 0 ? ((n - 1) * 1000) / span : 0,
        lod,
        camera: this.getCamera(),
        hovered: this.hovered ? `${this.hovered.layer}:${this.hovered.id}` : null,
        selected: this.selected,
        layers: this.renderer.stats(),
        layerMs: Object.fromEntries(this.renderer.timings),
      });
    }
  }

  private scheduleIdleRender(): void {
    clearTimeout(this.idleTimer);
    const wait = LOD.idleDelayMs - (performance.now() - this.lastMotionAt) + 5;
    this.idleTimer = window.setTimeout(() => {
      if (this.isMoving()) return this.scheduleIdleRender();
      this.invalidate();
      // The globe may have moved under a stationary cursor.
      if (this.lastPointer && this.interactive) {
        const { x, y } = this.lastPointer;
        this.setHovered(this.hitTestTop(x, y), { x, y });
      }
    }, Math.max(0, wait));
  }

  private measure(): void {
    this.viewport = {
      width: Math.max(1, this.container.clientWidth),
      height: Math.max(1, this.container.clientHeight),
    };
    this.dpr = Math.min(DEVICE_PIXEL_RATIO_CAP, window.devicePixelRatio || 1);
    // Assigning width/height clears the canvas even when unchanged, so only do it on a real change.
    const w = Math.round(this.viewport.width * this.dpr);
    const h = Math.round(this.viewport.height * this.dpr);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  private onResize(): void {
    const { width, height } = this.viewport;
    const dpr = this.dpr;
    this.measure();
    if (width === this.viewport.width && height === this.viewport.height && dpr === this.dpr) return;
    this.lastMotionAt = performance.now();
    this.invalidate();
  }

  private onDprChange = () => {
    this.onResize();
    this.watchDpr();
  };

  /** devicePixelRatio changes (browser zoom, moving between monitors) don't always fire resize. */
  private watchDpr(): void {
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.dprQuery.addEventListener('change', this.onDprChange);
  }
}
