import type { TextPart } from '../learn/layer';
import type { QuizController, QuizPhase } from '../quiz/QuizController';
import type { SettingsStore } from '../settings/store';
import type { QueueItem } from '../srs/queue';
import { GRADES, type Grade } from '../srs/scheduler';
import { h } from './dom';
import { renderSessionSummary } from './sessionSummary';
import { renderStartScreen } from './startScreen';

const GRADE_LABEL: Record<Grade, string> = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' };

type Item = Extract<QuizPhase, { item: unknown }>;

/**
 * Bottom-centre Learn panel. Renders the start screen, the current question
 * phase or the session summary from QuizController state. Question wording
 * comes from the item's layer.
 */
export class QuizPanel {
  private timer = 0;
  private renderedPhase: QuizPhase | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly quiz: QuizController,
    private readonly settings: SettingsStore,
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
      case 'question':
        return this.frame(p, this.question(p));
      case 'reveal':
        return this.frame(p, this.reveal(p));
    }
  }

  /** Header (direction, progress, timer, stop) around a phase body. */
  private frame(p: Item, body: HTMLElement): HTMLElement {
    const { counts } = this.quiz.snapshot();
    const timer = h('span', { class: 'timer' });
    if (p.name === 'question' && this.settings.value.global.showTimer) {
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
        h('span', { class: `chip direction ${p.item.direction}` }, p.spec.chip),
        this.quiz.activeLayers().length > 1 && h('span', { class: 'layer-name' }, this.quiz.layer(p.item.layerId).name),
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

  private question(p: Extract<QuizPhase, { name: 'question' }>): HTMLElement {
    const prompt = h('p', { class: 'prompt' }, ...parts(p.spec.prompt));
    const tag = this.newTag(p.item);
    if (p.spec.answer === 'click') {
      return h(
        'div',
        { class: 'quiz-body' },
        tag,
        prompt,
        h('p', { class: 'muted' }, 'Click it on the globe. Drag to rotate, scroll to zoom.'),
        h('div', { class: 'actions' }, h('button', { onclick: () => this.quiz.giveUp() }, "I don't know")),
      );
    }
    const input = h('input', {
      class: 'answer',
      type: 'text',
      autocomplete: 'off',
      autocorrect: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      'aria-label': 'Answer',
      placeholder: 'Type the name',
    });
    const submit = () => this.quiz.answerTyped(input.value);
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
      tag,
      prompt,
      h('div', { class: 'answer-row' }, input, h('button', { class: 'primary', onclick: submit }, 'Answer')),
      h('div', { class: 'actions' }, h('button', { onclick: () => this.quiz.giveUp() }, "I don't know")),
    );
  }

  /** First-ever question about an item: say so, without showing where it is. */
  private newTag(item: QueueItem): HTMLElement | null {
    return item.firstForItem ? h('p', { class: 'eyebrow' }, `New ${this.quiz.layer(item.layerId).noun}`) : null;
  }

  private reveal(p: Extract<QuizPhase, { name: 'reveal' }>): HTMLElement {
    const r = p.result;
    const verdict = r.correct ? (r.typo ? 'Correct (spelling slip)' : 'Correct') : r.gaveUp ? 'Not answered' : 'Wrong';
    const detail = this.quiz.layer(p.item.layerId).revealDetail(p.item.itemId, p.item.direction, r).filter(Boolean);
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
      detail.length > 0 && h('p', { class: 'detail' }, ...parts(detail)),
      h('div', { class: 'grades' }, ...buttons),
      h('p', { class: 'hint' }, `Suggested: ${GRADE_LABEL[p.autoGrade]}. Enter accepts, 1–4 choose.`),
    );
  }

  private stopTimer(): void {
    clearInterval(this.timer);
  }
}

function parts(text: TextPart[]): (string | HTMLElement)[] {
  return text.map((t) => (typeof t === 'string' ? t : h('strong', {}, t.strong)));
}
