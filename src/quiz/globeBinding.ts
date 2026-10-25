import type { QuizView } from '../learn/layer';
import type { LabelMode } from '../types';
import type { QuizController, QuizPhase } from './QuizController';

/**
 * Drives the globe from quiz state. Generic part: labels off during questions
 * (restored afterwards) and clearing between questions; everything else is
 * delegated to the question's layer (presentQuestion / presentReveal).
 */
export class QuizGlobeBinding {
  private enabled = false;
  private active = false;
  private savedLabels: LabelMode = 'all';
  private lastPhase: QuizPhase | null = null;

  constructor(
    private readonly view: QuizView,
    private readonly quiz: QuizController,
  ) {
    quiz.subscribe((p) => this.enabled && this.apply(p));
  }

  /** Learn mode on/off. Off restores the explore state. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.lastPhase = null;
    if (on) this.apply(this.quiz.state);
    else this.exitSession();
  }

  private apply(p: QuizPhase): void {
    if (p === this.lastPhase) return;
    const prev = this.lastPhase;
    this.lastPhase = p;
    if (p.name === 'idle' || p.name === 'summary') return this.exitSession();
    this.enterSession();
    const layer = this.quiz.layer(p.item.layerId);
    if (p.name === 'question') {
      this.clearAll();
      this.view.globe.setLabelMode('none');
      layer.presentQuestion(this.view, p.item.itemId, p.item.direction, this.quiz.settings);
    } else if (!(prev?.name === 'reveal' && prev.item.key === p.item.key)) {
      // Re-selecting a grade re-emits reveal: only set up the reveal once.
      layer.presentReveal(this.view, p.item.itemId, p.item.direction, p.result, this.quiz.settings);
    }
  }

  private clearAll(): void {
    this.view.markers.clear();
    for (const l of this.quiz.layers) l.clearPresentation(this.view);
  }

  private enterSession(): void {
    if (this.active) return;
    this.active = true;
    this.savedLabels = this.view.globe.getLabelMode();
    this.view.globe.setSelected(null);
  }

  private exitSession(): void {
    this.clearAll();
    if (!this.active) return;
    this.active = false;
    this.view.globe.setLabelMode(this.savedLabels);
  }
}
