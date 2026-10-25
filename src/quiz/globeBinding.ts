import type { Globe } from '../globe/Globe';
import type { CountryId, CountryMeta, HighlightStyle, LabelMode } from '../types';
import type { QuizController, QuizPhase } from './QuizController';

/** Name questions and intros never zoom past this, so small countries keep their surroundings. */
const QUESTION_MAX_ZOOM = 8;
const QUESTION_FILL = 0.5;
const FLASHES = 3;
const FLASH_MS = 220;

/**
 * Drives the globe from quiz state: highlights, flights, labels off during
 * questions (restored afterwards). Keeps globe effects out of the controller.
 */
export class QuizGlobeBinding {
  private enabled = false;
  private active = false;
  private savedLabels: LabelMode = 'all';
  private flashTimer = 0;
  private lastPhase: QuizPhase | null = null;

  constructor(
    private readonly globe: Globe,
    private readonly quiz: QuizController,
    private readonly meta: ReadonlyMap<CountryId, CountryMeta>,
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

  /** True while a question is on screen (labels are forced off). */
  get inQuestion(): boolean {
    return this.active;
  }

  private apply(p: QuizPhase): void {
    if (p === this.lastPhase) return;
    const prev = this.lastPhase;
    this.lastPhase = p;
    clearInterval(this.flashTimer);
    if (p.name === 'idle' || p.name === 'summary') return this.exitSession();
    this.enterSession();
    const id = p.item.countryId;
    const anchor = this.meta.get(id)?.labelPoint;
    const frame = () =>
      void this.globe.flyToCountry(id, { anchor, maxZoom: QUESTION_MAX_ZOOM, fill: QUESTION_FILL });

    if (p.name === 'intro') {
      this.globe.setHighlights({ [id]: 'target' });
      frame();
    } else if (p.name === 'question') {
      if (p.item.direction === 'locate') {
        // The camera stays where it is: finding the country is the question.
        this.globe.clearHighlights();
      } else {
        this.globe.setHighlights({ [id]: 'target' });
        // Already framed by the intro for this country? Then don't fly again.
        if (!(prev?.name === 'intro' && prev.item.countryId === id)) frame();
      }
    } else if (p.name === 'reveal') {
      // Re-selecting a grade re-emits reveal: only set up the reveal once.
      if (prev?.name === 'reveal' && prev.item.key === p.item.key) return;
      const r = p.result;
      if (r.correct) {
        this.globe.setHighlights({ [id]: 'correct' });
      } else if (p.item.direction === 'locate') {
        const marks: Record<CountryId, HighlightStyle> = { [id]: 'correct' };
        if (r.clickedId && r.clickedId !== id) marks[r.clickedId] = 'wrong';
        this.globe.setHighlights(marks);
        void this.globe.flyToCountry(id, { anchor, maxZoom: QUESTION_MAX_ZOOM, fill: QUESTION_FILL }).then(() => this.flash(id, marks));
      } else {
        this.globe.setHighlights({ [id]: 'wrong' });
      }
    }
  }

  /** Blink the correct country so the eye finds it. */
  private flash(id: CountryId, marks: Record<CountryId, HighlightStyle>): void {
    if (this.quiz.state.name !== 'reveal') return;
    let n = 0;
    clearInterval(this.flashTimer);
    this.flashTimer = window.setInterval(() => {
      n++;
      const on = n % 2 === 0;
      const next = { ...marks };
      if (!on) delete next[id];
      this.globe.setHighlights(next);
      if (n >= FLASHES * 2) clearInterval(this.flashTimer);
    }, FLASH_MS);
  }

  private enterSession(): void {
    if (this.active) return;
    this.active = true;
    this.savedLabels = this.globe.getLabelMode();
    this.globe.setLabelMode('none');
    this.globe.setSelected(null);
  }

  private exitSession(): void {
    clearInterval(this.flashTimer);
    this.globe.clearHighlights();
    if (!this.active) return;
    this.active = false;
    this.globe.setLabelMode(this.savedLabels);
  }
}
