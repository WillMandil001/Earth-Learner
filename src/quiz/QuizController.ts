import type { ClickInput, Evaluation, LayerContext, LayerId, LearnLayer, QuestionSpec } from '../learn/layer';
import type { Settings } from '../settings/schema';
import type { SettingsStore } from '../settings/store';
import { clock, dayIndex } from '../srs/clock';
import { autoGrade } from '../srs/grading';
import {
  EMPTY_LAYER_DAILY,
  buildQueue,
  pickNext,
  pickNextAhead,
  type CardRecord,
  type DailyCounters,
  type LayerDaily,
  type QueueItem,
  type QueueSnapshot,
} from '../srs/queue';
import { Scheduler, cardState, type CardState, type Grade, type PreviewItem } from '../srs/scheduler';
import { SCHEMA_VERSION, type MetaRecord, type Store } from '../storage/db';
import type { LonLat } from '../types';

/** How many cards one "Review ahead" press offers. */
export const REVIEW_AHEAD_BATCH = 20;

export interface AnswerResult extends Evaluation {
  /** Raw answer: typed text, or the clicked feature ID ('' for open sea / gave up). */
  answer: string;
  /** Where on the globe the user clicked (locate questions). */
  clickLonLat: LonLat | null;
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
  | { name: 'question'; item: QueueItem; spec: QuestionSpec }
  | {
      name: 'reveal';
      item: QueueItem;
      spec: QuestionSpec;
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
  settings: SettingsStore;
  layers: readonly LearnLayer[];
}

const NO_ANSWER: Evaluation = { correct: false, typo: false, gradeCap: null, clickedItemId: null, distanceKm: null, matchedItemId: null };

/**
 * The learning loop as an explicit state machine:
 * idle → question → reveal → next question … → summary → idle.
 * Layer-agnostic: everything about a kind of feature comes from its LearnLayer.
 * UI components render from `phase`; nothing here touches the DOM or the globe.
 */
export class QuizController {
  private phase: QuizPhase = { name: 'idle' };
  private listeners = new Set<(p: QuizPhase) => void>();
  private readonly scheduler: Scheduler;
  private readonly byId: ReadonlyMap<LayerId, LearnLayer>;
  private cards = new Map<string, CardRecord>();
  private daily: DailyCounters = { day: 0, layers: {} };
  private mode: SessionMode = 'normal';
  private reviewsSinceNew = 0;
  private aheadLeft = 0;
  private stats: SessionStats = { reviewed: 0, correct: 0, startedAt: 0, endedAt: 0 };
  /** performance.now() when the current question appeared (wall time, unaffected by time travel). */
  private shownAt = 0;

  private constructor(private readonly deps: Deps) {
    this.scheduler = new Scheduler(deps.settings.value.fsrs);
    this.byId = new Map(deps.layers.map((l) => [l.id, l]));
    deps.settings.subscribe((s) => {
      this.scheduler.configure(s.fsrs);
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
    this.daily = meta?.daily ?? { day: 0, layers: {} };
    this.phase = { name: 'idle' };
    this.emit();
  }

  get state(): QuizPhase {
    return this.phase;
  }

  get settings(): Settings {
    return this.deps.settings.value;
  }

  subscribe(listener: (p: QuizPhase) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** All registered layers. */
  get layers(): readonly LearnLayer[] {
    return this.deps.layers;
  }

  layer(id: LayerId): LearnLayer {
    return this.byId.get(id)!;
  }

  /** Layers a session draws from: enabled, and matching the layer filter. */
  activeLayers(settings = this.settings): LearnLayer[] {
    const filter = settings.global.layerFilter;
    return this.deps.layers.filter((l) => l.enabled(settings) && (filter === 'all' || filter === l.id));
  }

  /** Read-only card states (for layers' prerequisite checks and debug tools). */
  get cardRecords(): ReadonlyMap<string, CardRecord> {
    return this.cards;
  }

  /** Today's queue (counts for the start screen, pause state…). */
  snapshot(now = clock.now()): QueueSnapshot {
    const ctx: LayerContext = { settings: this.settings, cards: this.cards };
    return buildQueue({
      now,
      cards: this.cards,
      layers: this.activeLayers().map((l) => l.queueConfig(ctx)),
      daily: this.today(now),
      dayStartHour: this.settings.global.dayStartHour,
      retrievability: (c, t) => this.scheduler.retrievability(c, t),
    });
  }

  displayName(item: { layerId: LayerId; itemId: string }): string {
    return this.layer(item.layerId).displayName(item.itemId);
  }

  // ---- Session flow -----------------------------------------------------------

  start(mode: SessionMode = 'normal'): void {
    this.mode = mode;
    this.reviewsSinceNew = 0;
    this.aheadLeft = REVIEW_AHEAD_BATCH;
    this.stats = { reviewed: 0, correct: 0, startedAt: Date.now(), endedAt: 0 };
    this.advance();
  }

  /** One extra batch of new items (per active layer) beyond today's limit, then continue. */
  async learnMore(): Promise<void> {
    const now = clock.now();
    const daily = this.today(now);
    const layers = { ...daily.layers };
    for (const l of this.activeLayers()) {
      const c = layers[l.id] ?? EMPTY_LAYER_DAILY;
      layers[l.id] = { ...c, extraNew: c.extraNew + this.settings.layers[l.id].newPerDay };
    }
    this.daily = { ...daily, layers };
    await this.deps.store.saveMeta(this.meta());
    this.start('normal');
  }

  /** Locate answer: what was clicked on the globe. */
  answerClick(click: ClickInput): void {
    const p = this.phase;
    if (p.name !== 'question' || p.spec.answer !== 'click') return;
    const ev = this.layer(p.item.layerId).evaluateClick(p.item.itemId, click, this.settings);
    this.reveal({ ...ev, answer: ev.clickedItemId ?? '', clickLonLat: click.lonLat, gaveUp: false, elapsedMs: this.elapsed() });
  }

  /** Typed answer. */
  answerTyped(text: string): void {
    const p = this.phase;
    if (p.name !== 'question' || p.spec.answer !== 'type') return;
    const ev = this.layer(p.item.layerId).evaluateTyped(p.item.itemId, p.item.direction, text, this.settings);
    this.reveal({ ...ev, answer: text, clickLonLat: null, gaveUp: !text.trim(), elapsedMs: this.elapsed() });
  }

  /** "I don't know": graded Again. */
  giveUp(): void {
    if (this.phase.name !== 'question') return;
    this.reveal({ ...NO_ANSWER, answer: '', clickLonLat: null, gaveUp: true, elapsedMs: this.elapsed() });
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
    const today = dayIndex(now, this.settings.global.dayStartHour);
    const { item } = p;
    const prev = this.cards.get(item.key);
    const out = this.scheduler.review(prev?.card ?? this.scheduler.newCard(now), now, p.selected);
    const rec: CardRecord = {
      key: item.key,
      layerId: item.layerId,
      itemId: item.itemId,
      direction: item.direction,
      card: out.card,
      introducedDay: prev?.introducedDay ?? today,
    };
    const daily = this.today(now);
    const counters: LayerDaily = daily.layers[item.layerId] ?? EMPTY_LAYER_DAILY;
    this.daily = {
      ...daily,
      layers: { ...daily.layers, [item.layerId]: { ...counters, reviewsDone: counters.reviewsDone + (item.kind === 'review' ? 1 : 0) } },
    };
    this.cards.set(rec.key, rec);
    // Mark the phase as committed before awaiting, so a second keypress can't double-grade.
    this.phase = { name: 'idle' };
    await this.deps.store.saveAnswer(
      rec,
      {
        key: rec.key,
        layerId: rec.layerId,
        itemId: rec.itemId,
        direction: rec.direction,
        kind: item.kind,
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
    if (item.kind === 'new') this.reviewsSinceNew = 0;
    else if (item.kind === 'review') this.reviewsSinceNew++;
    if (this.mode === 'ahead' && item.kind === 'ahead') this.aheadLeft--;
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
    return {
      key: p.item.key,
      state: rec ? cardState(rec.card) : 'new',
      stability: rec?.card.stability ?? 0,
      difficulty: rec?.card.difficulty ?? 0,
      retrievability: rec ? this.scheduler.retrievability(rec.card, clock.now()) : 0,
      due: rec ? new Date(rec.card.due) : null,
    };
  }

  // ---- Internals -------------------------------------------------------------------

  private elapsed(): number {
    return performance.now() - this.shownAt;
  }

  private today(now: Date): DailyCounters {
    const day = dayIndex(now, this.settings.global.dayStartHour);
    if (this.daily.day !== day) this.daily = { day, layers: {} };
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
        : pickNext(q, { reviewsSinceNew: this.reviewsSinceNew }, now, this.settings.global.learnAheadMinutes);
    if (!next) {
      this.phase = { name: 'summary', stats: { ...this.stats, endedAt: Date.now() }, mode: this.mode };
      this.emit();
      return;
    }
    const spec = this.layer(next.layerId).question(next.itemId, next.direction, this.settings);
    this.phase = { name: 'question', item: next, spec };
    this.shownAt = performance.now();
    this.emit();
  }

  private reveal(result: AnswerResult): void {
    const p = this.phase;
    if (p.name !== 'question') return;
    const now = clock.now();
    const { thresholds } = this.layer(p.item.layerId).grading(p.item.direction, this.settings);
    const grade = autoGrade({ correct: result.correct, typo: result.typo, cap: result.gradeCap, elapsedMs: result.elapsedMs, thresholds });
    const card = this.cards.get(p.item.key)?.card ?? this.scheduler.newCard(now);
    this.phase = {
      name: 'reveal',
      item: p.item,
      spec: p.spec,
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
