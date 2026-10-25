import type { QuizController } from '../quiz/QuizController';
import type { SettingsStore } from '../settings/store';
import { h } from './dom';

/** Learn-mode landing card: what to study, today's counts, and Start. */
export function renderStartScreen(quiz: QuizController, settings: SettingsStore): HTMLElement {
  const q = quiz.snapshot();
  const { counts } = q;
  const nothing = counts.new + counts.learning + counts.due === 0;
  const enabled = quiz.layers.filter((l) => l.enabled(settings.value));
  const filter = settings.value.global.layerFilter;
  const select = h('select', {
    'aria-label': 'Layers to study',
    onchange: (e: Event) => void settings.set('global.layerFilter', (e.target as HTMLSelectElement).value),
  });
  select.append(h('option', { value: 'all', selected: filter === 'all' }, 'All enabled layers'));
  for (const l of enabled) select.append(h('option', { value: l.id, selected: filter === l.id }, `${l.name} only`));

  const active = quiz.activeLayers();
  const paused = active.filter((l) => q.byLayer[l.id]?.pausedNew);
  return h(
    'div',
    { class: 'start-screen' },
    h('h2', {}, 'Learn'),
    h(
      'div',
      { class: 'count-tiles' },
      tile('New', counts.new, 'new'),
      tile('Learning', counts.learning, 'learning'),
      tile('Due', counts.due, 'due'),
    ),
    active.length > 1 &&
      h(
        'p',
        { class: 'layer-breakdown muted' },
        active
          .map((l) => {
            const c = q.byLayer[l.id];
            return `${l.name}: ${c?.new ?? 0} new · ${c?.learning ?? 0} learning · ${c?.due ?? 0} due`;
          })
          .join('   |   '),
      ),
    ...paused.map((l) =>
      h('p', { class: 'notice' }, `New ${l.name.toLowerCase()} are paused: too many ${l.noun} reviews are due. Catch up first.`),
    ),
    h('label', { class: 'inline-field' }, h('span', {}, 'Study'), select),
    !active.length && h('p', { class: 'notice' }, 'No layers are enabled. Turn one on in Settings.'),
    nothing && active.length > 0 && h('p', { class: 'muted' }, 'Nothing is due right now. Learn more, review ahead, or come back later.'),
    h(
      'div',
      { class: 'actions' },
      nothing && h('button', { class: 'primary', disabled: q.pausedNew || !active.length, onclick: () => void quiz.learnMore() }, 'Learn more'),
      nothing && h('button', { disabled: !q.ahead.length, onclick: () => quiz.start('ahead') }, 'Review ahead'),
      !nothing && h('button', { class: 'primary', onclick: () => quiz.start() }, 'Start session'),
    ),
  );
}

function tile(label: string, n: number, kind: string): HTMLElement {
  return h('div', { class: `count-tile ${kind}` }, h('strong', {}, String(n)), h('span', {}, label));
}
