import type { RenderStats } from '../globe/Globe';
import type { CardDebugInfo } from '../quiz/QuizController';
import { DAY, HOUR, clock } from '../srs/clock';
import { h } from './dom';

const UPDATE_MS = 200;

interface HudOptions {
  /** Current quiz card, if any. */
  card(): CardDebugInfo | null;
  /** Called after the clock is moved, so views depending on "now" can refresh. */
  onTimeTravel(): void;
}

/** Top-right debug readout, toggled with D. Updates are throttled so the HUD itself costs ~nothing. */
export class DebugHud {
  private readonly el: HTMLElement;
  private readonly text: HTMLPreElement;
  private readonly clockLine: HTMLElement;
  private latest: RenderStats | null = null;
  private lastUpdate = 0;
  private timer = 0;

  constructor(
    parent: HTMLElement,
    private readonly opts: HudOptions,
    visible = false,
  ) {
    this.text = h('pre', {});
    this.clockLine = h('div', { class: 'hud-clock' });
    const travel = (ms: number) => () => {
      clock.advance(ms);
      this.paint();
      opts.onTimeTravel();
    };
    this.el = h(
      'div',
      { class: 'debug-hud', hidden: !visible },
      this.text,
      this.clockLine,
      h(
        'div',
        { class: 'hud-buttons' },
        h('button', { onclick: travel(HOUR) }, '+1h'),
        h('button', { onclick: travel(DAY) }, '+1d'),
        h('button', { onclick: travel(7 * DAY) }, '+7d'),
        h(
          'button',
          {
            onclick: () => {
              clock.reset();
              this.paint();
              opts.onTimeTravel();
            },
          },
          'Reset clock',
        ),
      ),
    );
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

  /** Repaint now (e.g. when the quiz card changes without a globe frame). */
  paint(): void {
    const s = this.latest;
    if (!s || this.el.hidden) return;
    this.lastUpdate = performance.now();
    const c = s.camera;
    const lines = [
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
    ];
    const card = this.opts.card();
    if (card) {
      lines.push(
        `card     ${card.key}  ${card.state}`,
        `         S ${card.stability.toFixed(2)}  D ${card.difficulty.toFixed(2)}  R ${(card.retrievability * 100).toFixed(0)}%`,
        `         due ${card.due ? card.due.toLocaleString() : '–'}`,
      );
    }
    this.text.textContent = lines.join('\n');
    const offset = clock.offsetMs;
    this.clockLine.textContent = `clock    ${clock.now().toLocaleString()}${offset ? `  (+${(offset / DAY).toFixed(2)}d)` : ''}`;
    this.clockLine.classList.toggle('shifted', offset !== 0);
  }
}
