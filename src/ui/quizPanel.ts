import type { QuizController, QuizPhase } from '../quiz/QuizController';
import type { SettingsStore } from '../settings/store';
import { GRADES, type Grade } from '../srs/scheduler';
import type { CountryId, CountryMeta } from '../types';
import { h } from './dom';
import { renderSessionSummary } from './sessionSummary';
import { renderStartScreen } from './startScreen';

const GRADE_LABEL: Record<Grade, string> = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' };

/**
 * Bottom-centre Learn panel. Renders the start screen, the current question
 * phase or the session summary from QuizController state.
 */
export class QuizPanel {
  private timer = 0;
  private renderedPhase: QuizPhase | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly quiz: QuizController,
    private readonly settings: SettingsStore,
    private readonly meta: ReadonlyMap<CountryId, CountryMeta>,
    private readonly onExplore: () => void,
  ) {
    quiz.subscribe(() => this.render());
  }

  show(visible: boolean): void {
    this.el.hidden = !visible;
    if (visible) this.render(true);
    else this.stopTimer();
  }

  /** Re-render (e.g. after time travel or a settings change). */
  render(force = false): void {
    if (this.el.hidden) return;
    const p = this.quiz.state;
    // Don't rebuild a question that is already on screen: it would drop typed text and focus.
    if (!force && p === this.renderedPhase) return;
    this.renderedPhase = p;
    this.stopTimer();
    this.el.replaceChildren(this.view(p));
    this.el.dataset.phase = p.name;
    this.el.querySelector<HTMLInputElement>('input.answer')?.focus();
  }

  private view(p: QuizPhase): HTMLElement {
    switch (p.name) {
      case 'idle':
        return renderStartScreen(this.quiz, this.settings);
      case 'summary':
        return renderSessionSummary(this.quiz, p.stats, this.onExplore);
      case 'intro':
        return this.frame(p, this.intro(p.item.countryId));
      case 'question':
        return this.frame(p, p.item.direction === 'locate' ? this.locate(p.item.countryId) : this.name());
      case 'reveal':
        return this.frame(p, this.reveal(p));
    }
  }

  /** Header (direction, progress, timer, stop) around a phase body. */
  private frame(p: Extract<QuizPhase, { item: unknown }>, body: HTMLElement): HTMLElement {
    const { counts } = this.quiz.snapshot();
    const timer = h('span', { class: 'timer' });
    if (p.name === 'question' && this.settings.value.display.showTimer) {
      const started = performance.now();
      const tick = () => (timer.textContent = `${Math.floor((performance.now() - started) / 1000)}s`);
      tick();
      this.timer = window.setInterval(tick, 500);
    }
    return h(
      'div',
      { class: 'quiz-card' },
      h(
        'div',
        { class: 'quiz-header' },
        h('span', { class: `chip direction ${p.item.direction}` }, p.item.direction === 'locate' ? 'Find it' : 'Name it'),
        h(
          'span',
          { class: 'progress', title: 'New · Learning · Due' },
          h('span', { class: 'n-new' }, String(counts.new)),
          ' · ',
          h('span', { class: 'n-learning' }, String(counts.learning)),
          ' · ',
          h('span', { class: 'n-due' }, String(counts.due)),
        ),
        timer,
        h('button', { class: 'link-button', title: 'End session', onclick: () => this.quiz.stop() }, 'End'),
      ),
      body,
    );
  }

  private intro(id: CountryId): HTMLElement {
    const m = this.meta.get(id);
    return h(
      'div',
      { class: 'quiz-body' },
      h('p', { class: 'eyebrow' }, 'New country'),
      h('h2', { class: 'country-name' }, this.quiz.displayName(id)),
      m && h('p', { class: 'muted' }, [m.subregion, m.continent].filter((x, i, a) => x && a.indexOf(x) === i).join(' · ')),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => this.quiz.continueIntro() }, 'Continue ⏎')),
    );
  }

  private locate(id: CountryId): HTMLElement {
    return h(
      'div',
      { class: 'quiz-body' },
      h('p', { class: 'prompt' }, 'Find: ', h('strong', {}, this.quiz.displayName(id))),
      h('p', { class: 'muted' }, 'Click it on the globe. Drag to rotate, scroll to zoom.'),
      h('div', { class: 'actions' }, h('button', { onclick: () => this.quiz.giveUp() }, "I don't know")),
    );
  }

  private name(): HTMLElement {
    const input = h('input', {
      class: 'answer',
      type: 'text',
      autocomplete: 'off',
      autocorrect: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      'aria-label': 'Country name',
      placeholder: 'Type the country name',
    });
    const submit = () => this.quiz.answerName(input.value);
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      // Stop here so the same Enter doesn't also accept the reveal that follows.
      e.stopPropagation();
      submit();
    });
    return h(
      'div',
      { class: 'quiz-body' },
      h('p', { class: 'prompt' }, 'Name the highlighted country'),
      h('div', { class: 'answer-row' }, input, h('button', { class: 'primary', onclick: submit }, 'Answer')),
      h('div', { class: 'actions' }, h('button', { onclick: () => this.quiz.giveUp() }, "I don't know")),
    );
  }

  private reveal(p: Extract<QuizPhase, { name: 'reveal' }>): HTMLElement {
    const target = this.quiz.displayName(p.item.countryId);
    const r = p.result;
    let verdict: string;
    let detail: (string | HTMLElement)[] = [];
    if (r.correct) {
      verdict = r.typo ? 'Correct (spelling slip)' : 'Correct';
      if (r.typo) detail = ['Spelled: ', h('strong', {}, target)];
      else if (p.item.direction === 'name') detail = [h('strong', {}, target)];
    } else {
      verdict = r.gaveUp ? 'Not answered' : 'Wrong';
      if (p.item.direction === 'locate') {
        const clicked = r.clickedId ? (this.meta.get(r.clickedId)?.name ?? r.clickedId) : null;
        detail = [
          'This is ',
          h('strong', {}, target),
          '. ',
          clicked
            ? `You clicked ${clicked}${
                r.kmOff === null ? '.' : r.kmOff === 0 ? ', which borders it.' : `: you were ${r.kmOff.toLocaleString()} km off.`
              }`
            : r.gaveUp
              ? ''
              : 'You clicked the sea.',
        ];
      } else {
        detail = [
          'It is ',
          h('strong', {}, target),
          '.',
          r.matchedOther ? ` "${r.answer.trim()}" is ${this.quiz.displayName(r.matchedOther)}.` : '',
        ];
      }
    }
    const buttons = GRADES.map((g, i) =>
      h(
        'button',
        {
          class: `grade ${g}${g === p.selected ? ' selected' : ''}${g === p.autoGrade ? ' auto' : ''}`,
          'aria-pressed': String(g === p.selected),
          title: `${i + 1}`,
          onclick: () => {
            this.quiz.select(g);
            void this.quiz.accept();
          },
        },
        h('span', { class: 'grade-label' }, `${i + 1} ${GRADE_LABEL[g]}`),
        h('span', { class: 'grade-interval' }, p.preview[g].interval),
      ),
    );
    return h(
      'div',
      { class: 'quiz-body' },
      h('p', { class: `verdict ${r.correct ? 'correct' : 'wrong'}` }, verdict),
      detail.length > 0 && h('p', { class: 'detail' }, ...detail),
      h('div', { class: 'grades' }, ...buttons),
      h('p', { class: 'hint' }, `Suggested: ${GRADE_LABEL[p.autoGrade]}. Enter accepts, 1–4 choose.`),
    );
  }

  private stopTimer(): void {
    clearInterval(this.timer);
  }
}
