import type { QuizController, SessionStats } from '../quiz/QuizController';
import { formatDuration, h } from './dom';

/** End-of-session card. */
export function renderSessionSummary(quiz: QuizController, stats: SessionStats, onExplore: () => void): HTMLElement {
  const q = quiz.snapshot();
  const accuracy = stats.reviewed ? Math.round((100 * stats.correct) / stats.reviewed) : 0;
  return h(
    'div',
    { class: 'session-summary' },
    h('h2', {}, stats.reviewed ? 'Session complete' : 'Nothing due right now'),
    stats.reviewed > 0 &&
      h(
        'div',
        { class: 'count-tiles' },
        stat('Answered', String(stats.reviewed)),
        stat('Correct', `${accuracy}%`),
        stat('Time', formatDuration(stats.endedAt - stats.startedAt)),
      ),
    q.counts.learning > 0 && h('p', { class: 'muted' }, `${q.counts.learning} card(s) in short-term learning will be due again soon.`),
    q.pausedNew && h('p', { class: 'notice' }, 'New countries are paused until due reviews are under the threshold.'),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'primary', disabled: q.pausedNew, title: 'One extra batch of new countries', onclick: () => void quiz.learnMore() }, 'Learn more'),
      h('button', { disabled: !q.ahead.length, title: 'Review cards before they are due', onclick: () => quiz.start('ahead') }, 'Review ahead'),
      h('button', { onclick: onExplore }, 'Back to explore'),
    ),
  );
}

function stat(label: string, value: string): HTMLElement {
  return h('div', { class: 'count-tile' }, h('strong', {}, value), h('span', {}, label));
}
