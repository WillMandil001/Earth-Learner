import { h } from './dom';

export interface LayerToggle {
  id: string;
  label: string;
  get(): boolean;
  set(on: boolean): void;
}

const STORAGE_KEY = 'earth-learner:layers';

/** Bottom-left Explore overlay listing map layers with on/off switches. Extend by adding toggles. */
export class LayersPanel {
  private readonly el: HTMLElement;
  private readonly inputs = new Map<string, HTMLInputElement>();

  constructor(
    parent: HTMLElement,
    private readonly toggles: LayerToggle[],
  ) {
    this.el = h('section', { class: 'layers-panel overlay', 'aria-label': 'Map layers' }, h('h3', {}, 'Layers'));
    for (const t of toggles) {
      const input = h('input', { type: 'checkbox', onchange: () => this.apply(t, input.checked) });
      this.inputs.set(t.id, input);
      this.el.append(h('label', {}, input, h('span', {}, t.label)));
    }
    parent.append(this.el);
    // Restore the viewer's last choices (a per-browser convenience).
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, boolean>;
      for (const t of toggles) if (typeof saved[t.id] === 'boolean') t.set(saved[t.id]!);
    } catch {
      // Storage unavailable or corrupt: keep defaults.
    }
    this.sync();
  }

  show(visible: boolean): void {
    this.el.hidden = !visible;
  }

  /** Refresh checkboxes after a toggle changed elsewhere (e.g. the L key). */
  sync(): void {
    for (const t of this.toggles) this.inputs.get(t.id)!.checked = t.get();
  }

  private apply(t: LayerToggle, on: boolean): void {
    t.set(on);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.toggles.map((x) => [x.id, x.get()]))));
    } catch {
      // Storage unavailable: the choice just isn't remembered.
    }
  }
}
