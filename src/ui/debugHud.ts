import type { RenderStats } from '../globe/Globe';

const UPDATE_MS = 200;

/** Top-right debug readout, toggled with D. Updates are throttled so the HUD itself costs ~nothing. */
export class DebugHud {
  private readonly el: HTMLPreElement;
  private latest: RenderStats | null = null;
  private lastUpdate = 0;
  private timer = 0;

  constructor(parent: HTMLElement, visible = false) {
    this.el = document.createElement('pre');
    this.el.className = 'debug-hud';
    this.el.hidden = !visible;
    parent.appendChild(this.el);
  }

  toggle(): void {
    this.el.hidden = !this.el.hidden;
    this.paint();
  }

  update(stats: RenderStats): void {
    this.latest = stats;
    if (this.el.hidden) return;
    const now = performance.now();
    clearTimeout(this.timer);
    if (now - this.lastUpdate >= UPDATE_MS) this.paint();
    // Make sure the final (idle) frame is always shown.
    else this.timer = window.setTimeout(() => this.paint(), UPDATE_MS);
  }

  private paint(): void {
    const s = this.latest;
    if (!s || this.el.hidden) return;
    this.lastUpdate = performance.now();
    const c = s.camera;
    this.el.textContent = [
      `fps      ${s.fps ? s.fps.toFixed(0) : 'idle'}`,
      `frame    ${s.frameMs.toFixed(1)} ms`,
      `layers   ${Object.entries(s.layerMs)
        .filter(([, ms]) => ms >= 0.1)
        .map(([id, ms]) => `${id} ${ms.toFixed(1)}`)
        .join('  ')}`,
      `lod      ${s.lod === 'high' ? '50m' : '110m'}`,
      `camera   ${c.lon.toFixed(2)}, ${c.lat.toFixed(2)}  z${c.zoom.toFixed(2)}`,
      `hovered  ${s.hovered ?? '–'}`,
      `selected ${s.selected ?? '–'}`,
      `visible  ${s.layers.visibleFeatures ?? 0}  markers ${s.layers.markers ?? 0}  labels ${s.layers.labels ?? 0}`,
    ].join('\n');
  }
}
