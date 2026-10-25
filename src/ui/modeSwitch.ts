import { h } from './dom';

export type AppMode = 'explore' | 'learn';

/** Top-left Explore | Learn switch plus the settings gear. */
export class ModeSwitch {
  private readonly buttons: Record<AppMode, HTMLButtonElement>;

  constructor(parent: HTMLElement, onMode: (m: AppMode) => void, onSettings: () => void) {
    this.buttons = {
      explore: h('button', { role: 'tab', onclick: () => onMode('explore') }, 'Explore'),
      learn: h('button', { role: 'tab', onclick: () => onMode('learn') }, 'Learn'),
    };
    parent.append(
      h(
        'nav',
        { class: 'mode-bar overlay' },
        h('div', { class: 'segmented', role: 'tablist' }, this.buttons.explore, this.buttons.learn),
        h('button', { class: 'icon-button', title: 'Settings', 'aria-label': 'Settings', onclick: onSettings }, '⚙'),
      ),
    );
  }

  set(mode: AppMode): void {
    for (const [m, b] of Object.entries(this.buttons)) b.setAttribute('aria-selected', String(m === mode));
  }
}
