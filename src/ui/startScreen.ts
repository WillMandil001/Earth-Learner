import type { QuizController } from '../quiz/QuizController';
import type { SettingsStore } from '../settings/store';
import { FIELDS } from '../settings/schema';
import { h } from './dom';

const directionField = FIELDS.find((f) => f.path === 'learning.directionMode')!;

/** Learn-mode landing card: today's counts, direction mode and Start. */
export function renderStartScreen(quiz: QuizController, settings: SettingsStore): HTMLElement {
  const q = quiz.snapshot();
  const { counts } = q;
  const nothing = counts.new + counts.learning + counts.due === 0;
  const select = h('select', {
    'aria-label': 'Question directions',
    onchange: (e: Event) => void settings.set('learning.directionMode', (e.target as HTMLSelectElement).value),
  });
  if (directionField.kind === 'select') {
    for (const o of directionField.options) {
      select.append(h('option', { value: o.value, selected: o.value === settings.value.learning.directionMode }, o.label));
    }
  }
  return h(
    'div',
    { class: 'start-screen' },
    h('h2', {}, 'Learn countries'),
    h(
      'div',
      { class: 'count-tiles' },
      tile('New', counts.new, 'new'),
      tile('Learning', counts.learning, 'learning'),
      tile('Due', counts.due, 'due'),
    ),
    q.pausedNew &&
      h('p', { class: 'notice' }, `New countries are paused: more than ${settings.value.learning.pauseNewIfDueAbove} reviews are due. Catch up first.`),
    h('label', { class: 'inline-field' }, h('span', {}, 'Questions'), select),
    nothing
      ? h('p', { class: 'muted' }, "Nothing is due right now. Learn more countries, review ahead, or come back later.")
      : null,
    h(
      'div',
      { class: 'actions' },
      nothing && h('button', { class: 'primary', disabled: q.pausedNew, onclick: () => void quiz.learnMore() }, 'Learn more'),
      nothing && h('button', { disabled: !q.ahead.length, onclick: () => quiz.start('ahead') }, 'Review ahead'),
      !nothing && h('button', { class: 'primary', onclick: () => quiz.start() }, 'Start session'),
    ),
  );
}

function tile(label: string, n: number, kind: string): HTMLElement {
  return h('div', { class: `count-tile ${kind}` }, h('strong', {}, String(n)), h('span', {}, label));
}
