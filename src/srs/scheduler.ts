/**
 * The only module that imports ts-fsrs. Everything else uses these types and
 * functions, so the scheduler can be swapped without touching the app.
 */
import {
  Rating,
  State,
  checkParameters,
  createEmptyCard,
  default_enable_fuzz,
  default_enable_short_term,
  default_learning_steps,
  default_maximum_interval,
  default_relearning_steps,
  default_request_retention,
  default_w,
  fsrs,
  generatorParameters,
  type Card,
  type FSRS,
  type FSRSParameters,
  type Grade as FsrsGrade,
  type ReviewLog,
  type StepUnit,
} from 'ts-fsrs';
import { DAY, HOUR, MINUTE } from './clock';

export type Grade = 'again' | 'hard' | 'good' | 'easy';
export const GRADES: readonly Grade[] = ['again', 'hard', 'good', 'easy'];
export type CardState = 'new' | 'learning' | 'review' | 'relearning';

/** FSRS memory state of one card. */
export type SrsCard = Card;
/** FSRS review log entry. */
export type SrsReviewLog = ReviewLog;

export interface SchedulerParams {
  requestRetention: number;
  maximumInterval: number;
  /** Step strings such as "1m", "10m", "1h", "1d". */
  learningSteps: string[];
  relearningSteps: string[];
  enableShortTerm: boolean;
  enableFuzz: boolean;
  weights: number[];
}

export const DEFAULT_SCHEDULER_PARAMS: SchedulerParams = {
  requestRetention: default_request_retention,
  maximumInterval: default_maximum_interval,
  learningSteps: [...default_learning_steps],
  relearningSteps: [...default_relearning_steps],
  enableShortTerm: default_enable_short_term,
  enableFuzz: default_enable_fuzz,
  weights: [...default_w],
};

const RATING: Record<Grade, FsrsGrade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

const STATE: Record<State, CardState> = {
  [State.New]: 'new',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning',
};

export interface Outcome {
  card: SrsCard;
  log: SrsReviewLog;
}

export interface PreviewItem extends Outcome {
  /** Human-readable time until the card is next due, e.g. "10m", "3d". */
  interval: string;
}

export class Scheduler {
  private f!: FSRS;

  constructor(params: SchedulerParams = DEFAULT_SCHEDULER_PARAMS) {
    this.configure(params);
  }

  /** Apply new parameters. Affects future reviews only; stored due dates are untouched. */
  configure(p: SchedulerParams): void {
    this.f = fsrs(
      generatorParameters({
        request_retention: p.requestRetention,
        maximum_interval: p.maximumInterval,
        learning_steps: p.learningSteps as StepUnit[],
        relearning_steps: p.relearningSteps as StepUnit[],
        enable_short_term: p.enableShortTerm,
        enable_fuzz: p.enableFuzz,
        w: p.weights,
      }),
    );
  }

  /** The parameters ts-fsrs is actually using. */
  get parameters(): Readonly<FSRSParameters> {
    return this.f.parameters;
  }

  newCard(now: Date): SrsCard {
    return createEmptyCard(now);
  }

  preview(card: SrsCard, now: Date): Record<Grade, PreviewItem> {
    const p = this.f.repeat(card, now);
    const out = {} as Record<Grade, PreviewItem>;
    for (const g of GRADES) {
      const item = p[RATING[g]];
      out[g] = { ...item, interval: formatInterval(now, item.card.due) };
    }
    return out;
  }

  review(card: SrsCard, now: Date, grade: Grade): Outcome {
    return this.f.next(card, now, RATING[grade]);
  }

  /** Probability of recall now (0–1); 0 for new cards. */
  retrievability(card: SrsCard, now: Date): number {
    return card.state === State.New ? 0 : this.f.get_retrievability(card, now, false);
  }
}

export function cardState(card: SrsCard): CardState {
  return STATE[card.state];
}

export function gradeOfRating(rating: number): Grade | null {
  return GRADES.find((g) => RATING[g] === rating) ?? null;
}

export function formatInterval(from: Date, to: Date): string {
  const ms = Math.max(0, to.getTime() - from.getTime());
  if (ms < MINUTE) return '<1m';
  if (ms < HOUR) return `${Math.round(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
  const days = ms / DAY;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${(days / 30).toFixed(days < 300 ? 1 : 0).replace(/\.0$/, '')}mo`;
  return `${(days / 365).toFixed(1).replace(/\.0$/, '')}y`;
}

/** Parse "1m 10m 1h" into step strings. Empty text = no steps (FSRS manages them). */
export function parseSteps(text: string): { ok: true; steps: string[] } | { ok: false; error: string } {
  const parts = text.trim().split(/[\s,]+/).filter(Boolean);
  for (const p of parts) {
    const m = /^(\d+(?:\.\d+)?)([mhd])$/.exec(p);
    if (!m || Number(m[1]) <= 0) return { ok: false, error: `"${p}" is not a step; use e.g. 1m, 10m, 1h, 1d` };
  }
  return { ok: true, steps: parts };
}

/** Error message for an invalid weight vector, or null if ts-fsrs accepts it. */
export function validateWeights(w: number[]): string | null {
  if (w.some((x) => !Number.isFinite(x))) return 'Weights must all be numbers';
  try {
    checkParameters(w);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
