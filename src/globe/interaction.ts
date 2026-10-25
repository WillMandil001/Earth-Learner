import { INTERACTION } from '../config';
import type { Camera, LonLat } from '../types';
import { cameraWithPointAt, clampZoom, panByPixels, screenToLonLat, type Viewport } from './camera';

/** A per-frame motion driver. `step` returns false when finished. */
export interface Animator {
  step(now: number): boolean;
  cancel?(): void;
}

/** What the interaction layer needs from the Globe. Keeps this module testable and DOM-light. */
export interface InteractionHost {
  readonly element: HTMLElement;
  isEnabled(): boolean;
  getCamera(): Camera;
  getViewport(): Viewport;
  /** Apply a camera produced by user input (counts as motion for LOD). */
  moveCamera(cam: Camera): void;
  addAnimator(a: Animator): void;
  /** Stop flights, inertia and smoothed zoom; true if anything was moving. */
  cancelMotion(): boolean;
  zoomBy(factor: number): void;
  pointerHover(x: number, y: number): void;
  pointerLeave(): void;
  pointerTap(x: number, y: number, kind: 'click' | 'dblclick'): void;
  dragStateChanged(dragging: boolean): void;
}

interface Point {
  x: number;
  y: number;
}

interface DragState {
  start: Point;
  last: Point;
  moved: boolean;
  /** The press stopped inertia or a flight: it is never a click. */
  stoppedMotion: boolean;
  samples: { t: number; x: number; y: number }[];
}

interface PinchState {
  startDist: number;
  startZoom: number;
  geo: LonLat | null;
}

const VELOCITY_WINDOW_MS = 80;
const RELEASE_STILL_MS = 60;

export class Interaction {
  private pointers = new Map<number, Point>();
  private drag: DragState | null = null;
  private pinch: PinchState | null = null;
  private wheel: { logTarget: number; x: number; y: number; geo: LonLat | null } | null = null;
  private lastTap: { t: number; x: number; y: number } | null = null;
  private readonly cleanup: (() => void)[] = [];

  constructor(private readonly host: InteractionHost) {
    const el = host.element;
    this.listen(el, 'pointerdown', this.onPointerDown);
    this.listen(el, 'pointermove', this.onPointerMove);
    this.listen(el, 'pointerup', this.onPointerUp);
    this.listen(el, 'pointercancel', this.onPointerUp);
    this.listen(el, 'pointerleave', this.onPointerLeave);
    this.listen(el, 'wheel', this.onWheel, { passive: false });
    // Safari pinch-zoom gestures would otherwise zoom the page.
    this.listen(el, 'gesturestart', (e: Event) => e.preventDefault());
    this.listen(window, 'keydown', this.onKeyDown);
  }

  get dragging(): boolean {
    return !!this.drag?.moved || !!this.pinch;
  }

  destroy(): void {
    this.cleanup.forEach((f) => f());
  }

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement | Window,
    type: K | 'gesturestart',
    handler: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void {
    const h = handler as EventListener;
    target.addEventListener(type, h, opts);
    this.cleanup.push(() => target.removeEventListener(type, h, opts));
  }

  private local(e: PointerEvent | WheelEvent): Point {
    const r = this.host.element.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onPointerDown = (e: PointerEvent) => {
    if (!this.host.isEnabled() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    this.host.element.setPointerCapture(e.pointerId);
    const stoppedMotion = this.host.cancelMotion();
    this.wheel = null;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) {
      this.drag = { start: p, last: p, moved: false, stoppedMotion, samples: [{ t: performance.now(), ...p }] };
    } else if (this.pointers.size === 2) {
      this.startPinch();
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    const p = this.local(e);
    if (!this.pointers.has(e.pointerId)) {
      if (e.pointerType !== 'touch' && this.host.isEnabled()) this.host.pointerHover(p.x, p.y);
      return;
    }
    this.pointers.set(e.pointerId, p);
    if (this.pinch && this.pointers.size >= 2) return this.updatePinch();
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) > INTERACTION.dragThreshold) {
      d.moved = true;
      this.host.dragStateChanged(true);
    }
    if (!d.moved) return;
    const vp = this.host.getViewport();
    this.host.moveCamera(panByPixels(this.host.getCamera(), p.x - d.last.x, p.y - d.last.y, vp));
    d.last = p;
    const now = performance.now();
    d.samples.push({ t: now, ...p });
    while (d.samples.length > 2 && now - d.samples[0]!.t > VELOCITY_WINDOW_MS) d.samples.shift();
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      // Continue as a drag with the remaining finger, without inertia or a tap.
      const rest = [...this.pointers.values()][0];
      this.drag = rest ? { start: rest, last: rest, moved: true, stoppedMotion: false, samples: [] } : null;
      if (!rest) this.host.dragStateChanged(false);
      return;
    }
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (!d.moved) {
      if (e.type === 'pointerup' && !d.stoppedMotion) this.tap(this.local(e));
      return;
    }
    this.host.dragStateChanged(false);
    this.startInertia(d);
  };

  private onPointerLeave = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) this.host.pointerLeave();
  };

  private tap(p: Point): void {
    const now = performance.now();
    this.host.pointerTap(p.x, p.y, 'click');
    const last = this.lastTap;
    if (
      last &&
      now - last.t < INTERACTION.doubleTapMs &&
      Math.hypot(p.x - last.x, p.y - last.y) < INTERACTION.doubleTapDistance
    ) {
      this.lastTap = null;
      this.host.pointerTap(p.x, p.y, 'dblclick');
    } else {
      this.lastTap = { t: now, ...p };
    }
  }

  private startInertia(d: DragState): void {
    const now = performance.now();
    const first = d.samples[0];
    const last = d.samples[d.samples.length - 1];
    if (!first || !last || last.t === first.t || now - last.t > RELEASE_STILL_MS) return;
    let vx = (last.x - first.x) / (last.t - first.t);
    let vy = (last.y - first.y) / (last.t - first.t);
    let prev = now;
    this.host.addAnimator({
      step: (t) => {
        const dt = Math.min(64, t - prev);
        prev = t;
        const cam = this.host.getCamera();
        const next = panByPixels(cam, vx * dt, vy * dt, this.host.getViewport());
        if (Math.abs(next.lat) >= 90) vy = 0;
        this.host.moveCamera(next);
        const decay = Math.exp(-dt / INTERACTION.inertiaDecayMs);
        vx *= decay;
        vy *= decay;
        return Math.hypot(vx, vy) > INTERACTION.inertiaMinSpeed;
      },
    });
  }

  private pinchGeometry(): { dist: number; mid: Point } {
    const [a, b] = [...this.pointers.values()] as [Point, Point];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }

  private startPinch(): void {
    if (this.drag?.moved) this.host.dragStateChanged(false);
    this.drag = null;
    const { dist, mid } = this.pinchGeometry();
    const cam = this.host.getCamera();
    this.pinch = {
      startDist: Math.max(dist, 1),
      startZoom: cam.zoom,
      geo: screenToLonLat(cam, this.host.getViewport(), mid.x, mid.y),
    };
    this.host.dragStateChanged(true);
  }

  /** Two-finger pinch zooms about the midpoint, and moving the midpoint pans. */
  private updatePinch(): void {
    const pinch = this.pinch!;
    const { dist, mid } = this.pinchGeometry();
    const zoom = clampZoom((pinch.startZoom * dist) / pinch.startDist);
    const cam = this.host.getCamera();
    this.host.moveCamera(
      pinch.geo ? cameraWithPointAt(pinch.geo, mid.x, mid.y, zoom, cam, this.host.getViewport()) : { ...cam, zoom },
    );
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!this.host.isEnabled()) return;
    const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 400 : 1;
    // Trackpad pinch arrives as ctrl+wheel with small deltas, so it needs a stronger factor.
    const k = e.ctrlKey ? 0.01 : 0.0022;
    const delta = -Math.max(-300, Math.min(300, e.deltaY * unit)) * k;
    const p = this.local(e);
    const cam = this.host.getCamera();
    const geo = screenToLonLat(cam, this.host.getViewport(), p.x, p.y);
    if (this.wheel) {
      const logTarget = Math.log(clampZoom(Math.exp(this.wheel.logTarget + delta)));
      this.wheel = { logTarget, ...p, geo };
      return;
    }
    this.host.cancelMotion();
    this.wheel = { logTarget: Math.log(clampZoom(cam.zoom * Math.exp(delta))), ...p, geo };
    let prev = performance.now();
    this.host.addAnimator({
      step: (t) => {
        const w = this.wheel;
        if (!w) return false;
        const dt = Math.min(64, t - prev);
        prev = t;
        const current = this.host.getCamera();
        const lz = Math.log(current.zoom);
        const done = Math.abs(w.logTarget - lz) < 1e-3;
        const nextLz = done ? w.logTarget : lz + (w.logTarget - lz) * (1 - Math.exp(-dt / INTERACTION.wheelSmoothingMs));
        const zoom = Math.exp(nextLz);
        const vp = this.host.getViewport();
        this.host.moveCamera(w.geo ? cameraWithPointAt(w.geo, w.x, w.y, zoom, current, vp) : { ...current, zoom });
        if (done) this.wheel = null;
        return !done;
      },
      cancel: () => {
        this.wheel = null;
      },
    });
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.host.isEnabled() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const cam = this.host.getCamera();
    const step = INTERACTION.keyRotateDegrees / cam.zoom;
    const pan: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const d = pan[e.key];
    if (d) {
      this.host.cancelMotion();
      this.host.moveCamera({ ...cam, lon: cam.lon + d[0], lat: cam.lat + d[1] });
    } else if (e.key === '+' || e.key === '=') {
      this.host.zoomBy(INTERACTION.keyZoomFactor);
    } else if (e.key === '-' || e.key === '_') {
      this.host.zoomBy(1 / INTERACTION.keyZoomFactor);
    } else {
      return;
    }
    e.preventDefault();
  };
}
