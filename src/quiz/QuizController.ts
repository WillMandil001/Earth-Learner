import type { Settings } from '../settings/schema';
import type { SettingsStore } from '../settings/store';
import { buildNameIndex, matchAnswer, type NameIndex } from '../srs/answerMatch';
import { clock, dayIndex } from '../srs/clock';
import { autoGrade } from '../srs/grading';
import {
  buildQueue,
  introductionOrder,
  pickNext,
  pickNextAhead,
  type CardRecord,
  type DailyCounters,
  type QueueItem,
  type QueueSnapshot,
} from '../srs/queue';
import { Scheduler, cardState, type CardState, type Grade, type PreviewItem } from '../srs/scheduler';
import { SCHEMA_VERSION, type MetaRecord, type Store } from '../storage/db';
import type { CountryId } from '../types';
import { resolveClick, type QuizData } from './data';

/** How many cards one "Review ahead" press offers. */
export const REVIEW_AHEAD_BATCH = 20;

export interface AnswerResult {
  correct: boolean;
  /** Typed answer accepted with a spelling slip. */
  typo: boolean;
  /** Raw answer: typed text, or the clicked feature ID ('' for ocean / gave up). */
  answer: string;
  /** Locate: the feature clicked (null = ocean or gave up). */
  clickedId: CountryId | null;
  /** Locate: border-to-border km between what was clicked and the target. */
  kmOff: number | null;
  /** Name: the different country a wrong typed answer matched, if any. */
  matchedOther: CountryId | null;
  gaveUp: boolean;
  elapsedMs: number;
}

export interface SessionStats {
  reviewed: number;
  correct: number;
  startedAt: number;
  endedAt: number;
}

export type QuizPhase =
  | { name: 'idle' }
  | { name: 'question'; item: QueueItem }
  | {
      name: 'reveal';
      item: QueueItem;
      result: AnswerResult;
      autoGrade: Grade;
      selected: Grade;
      preview: Record<Grade, PreviewItem>;
    }
  | { name: 'summary'; stats: SessionStats; mode: SessionMode };

export type SessionMode = 'normal' | 'ahead';

export interface CardDebugInfo {
  key: string;
  state: CardState;
  stability: number;
  difficulty: number;
  retrievability: number;
  due: Date | null;
}

interface Deps {
  store: Store;
  data: QuizData;
  settings: SettingsStore;
  /** NE LABELRANK, to break distance ties in the introduction order. */
  labelRank(id: CountryId): number;
}

/**
 * The learning loop as an explicit state machine:
 * idle → question → reveal → next question … → summary → idle.
 * UI components render from `phase`; nothing here touches the DOM or the globe.
 */
export class QuizController {
  private phase: QuizPhase = { name: 'idle' };
  private listeners = new Set<(p: QuizPhase) => void>();
  private readonly scheduler: Scheduler;
  private cards = new Map<string, CardRecord>();
  private daily: DailyCounters = { day: 0, reviewsDone: 0, extraNew: 0 };
  private order: CountryId[] = [];
  private names!: NameIndex;
  private mode: SessionMode = 'normal';
  private reviewsSinceNew = 0;
  private aheadLeft = 0;
  private stats: SessionStats = { reviewed: 0, correct: 0, startedAt: 0, endedAt: 0 };
  /** performance.now() when the current question appeared (wall time, unaffected by time travel). */
  private shownAt = 0;

  private constructor(private readonly deps: Deps) {
    this.scheduler = new Scheduler(deps.settings.value.fsrs);
    this.applySettings(deps.settings.value);
    deps.settings.subscribe((s) => {
      this.applySettings(s);
      this.emit();
    });
  }

  static async create(deps: Deps): Promise<QuizController> {
    const c = new QuizController(deps);
    await c.reload();
    return c;
  }

  /** Re-read cards and counters from storage (after import or reset). */
  async reload(): Promise<void> {
    this.cards = await this.deps.store.loadCards();
    const meta = await this.deps.store.loadMeta();
    this.daily = meta?.daily ?? { day: 0, reviewsDone: 0, extraNew: 0 };
    this.phase = { name: 'idle' };
    this.emit();
  }

  get state(): QuizPhase {
    return this.phase;
  }

  get settings(): Settings {
    return this.deps.settings.value;
  }

  get data(): QuizData {
    return this.deps.data;
  }

  subscribe(listener: (p: QuizPhase) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Today's queue (counts for the start screen, pause state…). */
  snapshot(now = clock.now()): QueueSnapshot {
    return buildQueue({
      now,
      cards: this.cards,
      settings: this.settings.learning,
      order: this.order,
      daily: this.today(now),
      retrievability: (c, t) => this.scheduler.retrievability(c, t),
    });
  }

  displayName(id: CountryId): string {
    return this.names.display.get(id) ?? id;
  }

  // ---- Session flow -----------------------------------------------------------

  start(mode: SessionMode = 'normal'): void {
    this.mode = mode;
    this.reviewsSinceNew = 0;
    this.aheadLeft = REVIEW_AHEAD_BATCH;
    this.stats = { reviewed: 0, correct: 0, startedAt: Date.now(), endedAt: 0 };
    this.advance();
  }

  /** One extra batch of new countries beyond today's limit, then continue. */
  async learnMore(): Promise<void> {
    const now = clock.now();
    this.daily = { ...this.today(now), extraNew: this.today(now).extraNew + this.settings.learning.newPerDay };
    await this.deps.store.saveMeta(this.meta());
    this.start('normal');
  }

  /** Locate answer: the feature clicked on the globe (null = ocean). */
  answerLocate(clickedId: CountryId | null): void {
    if (this.phase.name !== 'question' || this.phase.item.direction !== 'locate') return;
    const target = this.phase.item.countryId;
    const resolved = resolveClick(this.deps.data, this.settings.learning.scope, clickedId);
    const correct = resolved === target;
    const km = clickedId && !correct ? this.deps.data.distances.get(clickedId, target) : NaN;
    this.reveal({
      correct,
      typo: false,
      answer: clickedId ?? '',
      clickedId,
      kmOff: Number.isNaN(km) ? null : km,
      matchedOther: null,
      gaveUp: false,
      elapsedMs: performance.now() - this.shownAt,
    });
  }

  answerName(text: string): void {
    if (this.phase.name !== 'question' || this.phase.item.direction !== 'name') return;
    const m = matchAnswer(this.names, this.phase.item.countryId, text, this.settings.grading.typoTolerance);
    this.reveal({
      correct: m.kind === 'exact' || m.kind === 'typo',
      typo: m.kind === 'typo',
      answer: text,
      clickedId: null,
      kmOff: null,
      matchedOther: m.kind === 'wrong' ? m.other : null,
      gaveUp: m.kind === 'empty',
      elapsedMs: performance.now() - this.shownAt,
    });
  }

  /** "I don't know": graded Again. */
  giveUp(): void {
    if (this.phase.name !== 'question') return;
    this.reveal({
      correct: false,
      typo: false,
      answer: '',
      clickedId: null,
      kmOff: null,
      matchedOther: null,
      gaveUp: true,
      elapsedMs: performance.now() - this.shownAt,
    });
  }

  /** Change the selected grade on the reveal screen (not committed until accept). */
  select(grade: Grade): void {
    if (this.phase.name !== 'reveal') return;
    this.phase = { ...this.phase, selected: grade };
    this.emit();
  }

  /** Commit the selected grade and move on. */
  async accept(): Promise<void> {
    const p = this.phase;
    if (p.name !== 'reveal') return;
    const now = clock.now();
    const today = dayIndex(now, this.settings.learning.dayStartHour);
    const prev = this.cards.get(p.item.key);
    const out = this.scheduler.review(prev?.card ?? this.scheduler.newCard(now), now, p.selected);
    const rec: CardRecord = {
      key: p.item.key,
      countryId: p.item.countryId,
      direction: p.item.direction,
      card: out.card,
      introducedDay: prev?.introducedDay ?? today,
    };
    const daily = this.today(now);
    this.daily = { ...daily, reviewsDone: daily.reviewsDone + (p.item.kind === 'review' ? 1 : 0) };
    this.cards.set(rec.key, rec);
    // Mark the phase as committed before awaiting, so a second keypress can't double-grade.
    this.phase = { name: 'idle' };
    await this.deps.store.saveAnswer(
      rec,
      {
        key: rec.key,
        countryId: rec.countryId,
        direction: rec.direction,
        kind: p.item.kind,
        log: out.log,
        responseMs: Math.round(p.result.elapsedMs),
        answer: p.result.answer,
        autoGrade: p.autoGrade,
        grade: p.selected,
      },
      this.meta(),
    );
    this.stats.reviewed++;
    if (p.result.correct) this.stats.correct++;
    if (p.item.kind === 'new') this.reviewsSinceNew = 0;
    else if (p.item.kind === 'review') this.reviewsSinceNew++;
    if (this.mode === 'ahead' && p.item.kind === 'ahead') this.aheadLeft--;
    this.advance();
  }

  /** Leave the session (back to the start screen). Nothing ungraded is saved. */
  stop(): void {
    this.phase = { name: 'idle' };
    this.emit();
  }

  // ---- Debug -------------------------------------------------------------------

  currentCard(): CardDebugInfo | null {
    const p = this.phase;
    if (p.name !== 'question' && p.name !== 'reveal') return null;
    const rec = this.cards.get(p.item.key);
    const now = clock.now();
    return {
      key: p.item.key,
      state: rec ? cardState(rec.card) : 'new',
      stability: rec?.card.stability ?? 0,
      difficulty: rec?.card.difficulty ?? 0,
      retrievability: rec ? this.scheduler.retrievability(rec.card, now) : 0,
      due: rec ? new Date(rec.card.due) : null,
    };
  }

  // ---- Internals -------------------------------------------------------------------

  private applySettings(s: Settings): void {
    this.scheduler.configure(s.fsrs);
    const scope = this.deps.data.scopes[s.learning.scope];
    this.order = introductionOrder(s.learning.homeCountry, scope, (a, b) => this.deps.data.distances.get(a, b), this.deps.labelRank);
    this.names = buildNameIndex(this.deps.data.names, scope);
  }

  private today(now: Date): DailyCounters {
    const day = dayIndex(now, this.settings.learning.dayStartHour);
    if (this.daily.day !== day) this.daily = { day, reviewsDone: 0, extraNew: 0 };
    return this.daily;
  }

  private meta(): MetaRecord {
    return { schemaVersion: SCHEMA_VERSION, daily: this.daily };
  }

  private advance(): void {
    const now = clock.now();
    const q = this.snapshot(now);
    const next =
      this.mode === 'ahead'
        ? this.aheadLeft > 0
          ? pickNextAhead(q)
          : (q.learningNow[0] ?? null)
        : pickNext(q, { reviewsSinceNew: this.reviewsSinceNew }, now, this.settings.learning.learnAheadMinutes);
    if (!next) {
      this.phase = { name: 'summary', stats: { ...this.stats, endedAt: Date.now() }, mode: this.mode };
      this.emit();
      return;
    }
    this.ask(next);
  }

  private ask(item: QueueItem): void {
    this.phase = { name: 'question', item };
    this.shownAt = performance.now();
    this.emit();
  }

  private reveal(result: AnswerResult): void {
    const p = this.phase;
    if (p.name !== 'question') return;
    const now = clock.now();
    const thresholds = this.settings.grading[p.item.direction];
    const grade = autoGrade({ correct: result.correct, typo: result.typo, elapsedMs: result.elapsedMs, thresholds });
    const card = this.cards.get(p.item.key)?.card ?? this.scheduler.newCard(now);
    this.phase = {
      name: 'reveal',
      item: p.item,
      result,
      autoGrade: grade,
      selected: grade,
      preview: this.scheduler.preview(card, now),
    };
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach((l) => l(this.phase));
  }
}
