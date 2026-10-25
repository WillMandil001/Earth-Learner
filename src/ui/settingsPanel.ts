import type { QuizController } from '../quiz/QuizController';
import { DEFAULT_SETTINGS, FIELDS, getPath, type FieldSpec } from '../settings/schema';
import type { SettingsStore } from '../settings/store';
import { clock } from '../srs/clock';
import { parseSteps } from '../srs/scheduler';
import type { Store } from '../storage/db';
import { exportJson, parseImport } from '../storage/export';
import type { CountryId } from '../types';
import { h } from './dom';

const SECTIONS: { id: FieldSpec['section']; title: string; note?: string }[] = [
  { id: 'global', title: 'General' },
  {
    id: 'scheduler',
    title: 'Scheduler (FSRS)',
    note: 'Shared by all layers. Changes apply to future reviews; cards already scheduled keep their due dates.',
  },
  { id: 'layer:country', title: 'Countries' },
  { id: 'layer:capital', title: 'Capital cities' },
  {
    id: 'layer:city',
    title: 'Cities',
    note: 'Changing tiers or thresholds never deletes progress: cards outside the active set are just not scheduled.',
  },
];

const RESET_WORD = 'reset';

interface Deps {
  settings: SettingsStore;
  quiz: QuizController;
  store: Store;
  /** In-scope countries for the home-country picker, as [id, display name]. */
  countries: [CountryId, string][];
}

/** Gear-icon settings overlay. Every change is validated, applied and saved immediately. */
export class SettingsPanel {
  private readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private errors = new Map<string, string>();
  private dataMessage: HTMLElement | string | null = null;

  constructor(
    parent: HTMLElement,
    private readonly deps: Deps,
  ) {
    this.body = h('div', { class: 'settings-body' });
    this.el = h(
      'div',
      { class: 'modal-backdrop overlay', hidden: true, onclick: (e: Event) => e.target === this.el && this.close() },
      h(
        'section',
        { class: 'settings-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' },
        h(
          'header',
          {},
          h('h2', {}, 'Settings'),
          h('button', { class: 'info-close', 'aria-label': 'Close settings', onclick: () => this.close() }, '×'),
        ),
        this.body,
      ),
    );
    parent.append(this.el);
    deps.settings.subscribe(() => this.isOpen && this.render());
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(): void {
    this.errors.clear();
    this.dataMessage = null;
    this.el.hidden = false;
    this.render();
    this.el.querySelector<HTMLElement>('.info-close')?.focus();
  }

  close(): void {
    this.el.hidden = true;
  }

  private render(): void {
    const scroll = this.body.scrollTop;
    this.body.replaceChildren(
      ...SECTIONS.map((s) =>
        h(
          'fieldset',
          {},
          h('legend', {}, s.title),
          s.note && h('p', { class: 'section-note' }, s.note),
          ...FIELDS.filter((f) => f.section === s.id).map((f) => this.field(f)),
        ),
      ),
      this.dataSection(),
    );
    this.body.scrollTop = scroll;
  }

  private async set(path: string, value: unknown): Promise<void> {
    const err = await this.deps.settings.set(path, value);
    if (err) this.errors.set(path, err);
    else this.errors.delete(path);
    this.render();
  }

  private field(f: FieldSpec): HTMLElement {
    const value = getPath(this.deps.settings.value, f.path);
    const id = `setting-${f.path.replace(/\./g, '-')}`;
    let control: HTMLElement;
    let extra: HTMLElement | null = null;
    switch (f.kind) {
      case 'select': {
        control = h('select', { id, onchange: (e: Event) => void this.set(f.path, (e.target as HTMLSelectElement).value) });
        for (const o of f.options) control.append(h('option', { value: o.value, selected: o.value === value }, o.label));
        break;
      }
      case 'number':
        control = h('input', {
          id,
          type: 'number',
          min: f.min,
          max: f.max,
          step: f.step,
          value: String(value),
          onchange: (e: Event) => void this.set(f.path, Number((e.target as HTMLInputElement).value)),
        });
        break;
      case 'slider': {
        const out = h('output', { for: id }, Number(value).toFixed(2));
        control = h('input', {
          id,
          type: 'range',
          min: f.min,
          max: f.max,
          step: f.step,
          value: String(value),
          oninput: (e: Event) => (out.textContent = Number((e.target as HTMLInputElement).value).toFixed(2)),
          onchange: (e: Event) => void this.set(f.path, Number((e.target as HTMLInputElement).value)),
        });
        extra = out;
        break;
      }
      case 'boolean':
        control = h('input', {
          id,
          type: 'checkbox',
          checked: value === true,
          onchange: (e: Event) => void this.set(f.path, (e.target as HTMLInputElement).checked),
        });
        break;
      case 'steps':
        control = h('input', {
          id,
          type: 'text',
          value: (value as string[]).join(' '),
          spellcheck: 'false',
          onchange: (e: Event) => {
            const r = parseSteps((e.target as HTMLInputElement).value);
            if (r.ok) void this.set(f.path, r.steps);
            else {
              this.errors.set(f.path, r.error);
              this.render();
            }
          },
        });
        break;
      case 'weights':
        control = h('textarea', {
          id,
          rows: 3,
          spellcheck: 'false',
          onchange: (e: Event) => {
            const text = (e.target as HTMLTextAreaElement).value.trim();
            void this.set(f.path, text ? text.split(/[\s,]+/).map(Number) : []);
          },
        });
        (control as HTMLTextAreaElement).value = (value as number[]).join(', ');
        extra = h('button', { class: 'small', onclick: () => void this.set(f.path, [...DEFAULT_SETTINGS.fsrs.weights]) }, 'Reset to defaults');
        break;
      case 'country': {
        const listId = `${id}-list`;
        const byName = new Map(this.deps.countries.map(([cid, name]) => [name.toLowerCase(), cid]));
        const current = this.deps.countries.find(([cid]) => cid === value)?.[1] ?? String(value);
        control = h('input', {
          id,
          type: 'text',
          list: listId,
          value: current,
          spellcheck: 'false',
          onchange: (e: Event) => {
            const typed = (e.target as HTMLInputElement).value.trim().toLowerCase();
            const cid = byName.get(typed);
            if (cid) void this.set(f.path, cid);
            else {
              this.errors.set(f.path, 'Pick a country from the list');
              this.render();
            }
          },
        });
        extra = h('datalist', { id: listId }, ...this.deps.countries.map(([, name]) => h('option', { value: name })));
        break;
      }
    }
    const err = this.errors.get(f.path);
    return h(
      'div',
      { class: `setting ${f.kind}` },
      h('label', { for: id }, f.label),
      h('div', { class: 'control' }, control, extra),
      h('p', { class: 'description' }, f.description),
      err && h('p', { class: 'field-error', role: 'alert' }, err),
    );
  }

  private dataSection(): HTMLElement {
    const resetInput = h('input', { type: 'text', placeholder: `Type "${RESET_WORD}"`, 'aria-label': 'Confirm reset' });
    const resetButton = h('button', { class: 'danger', disabled: true, onclick: () => void this.reset() }, 'Reset all progress');
    resetInput.addEventListener('input', () => (resetButton.disabled = resetInput.value.trim().toLowerCase() !== RESET_WORD));
    const fileInput = h('input', {
      type: 'file',
      accept: 'application/json,.json',
      hidden: true,
      onchange: (e: Event) => void this.importFile((e.target as HTMLInputElement).files?.[0]),
    });
    return h(
      'fieldset',
      {},
      h('legend', {}, 'Data'),
      h(
        'div',
        { class: 'setting' },
        h('label', {}, 'Export progress'),
        h('div', { class: 'control' }, h('button', { onclick: () => void this.export() }, 'Download JSON')),
        h('p', { class: 'description' }, 'Cards, full review history and settings, as one file.'),
      ),
      h(
        'div',
        { class: 'setting' },
        h('label', {}, 'Import progress'),
        h('div', { class: 'control' }, fileInput, h('button', { onclick: () => fileInput.click() }, 'Choose file…')),
        h('p', { class: 'description' }, 'Replace everything here with an exported file. You confirm first.'),
      ),
      this.dataMessage && h('div', { class: 'data-message' }, this.dataMessage),
      h(
        'div',
        { class: 'setting' },
        h('label', {}, 'Reset all progress'),
        h('div', { class: 'control' }, resetInput, resetButton),
        h('p', { class: 'description' }, 'Deletes every card and the review history. Settings are kept. Cannot be undone.'),
      ),
    );
  }

  private async export(): Promise<void> {
    const now = clock.now();
    const json = exportJson(await this.deps.store.dump(), now);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = h('a', { href: url, download: `earth-learner-progress-${now.toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private async importFile(file: File | undefined): Promise<void> {
    if (!file) return;
    const parsed = parseImport(await file.text());
    if (!parsed.ok) {
      this.dataMessage = h('p', { class: 'field-error', role: 'alert' }, `Import failed: ${parsed.error}`);
      return this.render();
    }
    const current = await this.deps.store.dump();
    const s = parsed.summary;
    this.dataMessage = h(
      'div',
      { class: 'confirm' },
      h(
        'p',
        {},
        `This replaces your ${current.cards.length} cards and ${current.reviewLog.length} reviews with ` +
          `${s.cards} cards and ${s.reviews} reviews from ${file.name}` +
          (s.exportedAt ? ` (exported ${new Date(s.exportedAt).toLocaleString()})` : '') +
          (s.hasSettings ? '. Your settings will be replaced too.' : '.'),
      ),
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          {
            class: 'danger',
            onclick: async () => {
              await this.deps.store.replaceAll(parsed.dump);
              await this.deps.settings.reload();
              await this.deps.quiz.reload();
              this.dataMessage = `Imported ${s.cards} cards and ${s.reviews} reviews.`;
              this.render();
            },
          },
          'Replace my progress',
        ),
        h('button', { onclick: () => ((this.dataMessage = null), this.render()) }, 'Cancel'),
      ),
    );
    this.render();
  }

  private async reset(): Promise<void> {
    await this.deps.store.clearProgress();
    await this.deps.quiz.reload();
    this.dataMessage = 'All progress has been reset.';
    this.render();
  }
}
