import type { Direction, DirectionMode, LearningSettings } from '../settings/schema';
import type { CountryId } from '../types';
import { MINUTE, dayIndex, dayStart } from './clock';
import { cardState, type SrsCard } from './scheduler';

/** Stored state of one card: (country, direction). Cards without a record are new. */
export interface CardRecord {
  key: string;
  countryId: CountryId;
  direction: Direction;
  card: SrsCard;
  /** Day index (see clock.dayIndex) of the first answer. */
  introducedDay: number;
}

export const cardKey = (countryId: CountryId, direction: Direction): string => `${countryId}:${direction}`;
export const DIRECTIONS: readonly Direction[] = ['locate', 'name'];
const sibling = (d: Direction): Direction => (d === 'locate' ? 'name' : 'locate');

export function activeDirections(mode: DirectionMode): Direction[] {
  return mode === 'both' ? ['locate', 'name'] : [mode];
}

/** Per-day counters kept in storage; reset when the day changes. */
export interface DailyCounters {
  day: number;
  /** Review-state cards answered today (counts toward maxReviewsPerDay). */
  reviewsDone: number;
  /** Extra new countries granted today by "Learn more". */
  extraNew: number;
}

export type ItemKind = 'learning' | 'review' | 'new' | 'ahead';

export interface QueueItem {
  key: string;
  countryId: CountryId;
  direction: Direction;
  kind: ItemKind;
  /** First ever card for this country (as opposed to a next-day sibling). */
  firstForCountry: boolean;
}

export interface QueueInput {
  now: Date;
  cards: ReadonlyMap<string, CardRecord>;
  settings: LearningSettings;
  /** In-scope countries in introduction order (see introductionOrder). */
  order: readonly CountryId[];
  daily: DailyCounters;
  retrievability(card: SrsCard, now: Date): number;
}

export interface QueueSnapshot {
  /** Learning/relearning cards due now, earliest first. */
  learningNow: QueueItem[];
  /** Learning/relearning cards due later today, earliest first. */
  learningLater: { item: QueueItem; due: Date }[];
  /** Review cards due today, lowest retrievability first, capped by the daily limit. */
  reviews: QueueItem[];
  /** New cards available now, in introduction order. */
  newItems: QueueItem[];
  /** Review cards not due today, soonest first (for "Review ahead"). */
  ahead: QueueItem[];
  /** True if new cards are held back because too many reviews are due. */
  pausedNew: boolean;
  /** Countries introduced today so far. */
  newCountriesToday: number;
  counts: { new: number; learning: number; due: number };
}

/**
 * Introduction order: home first, then by border-to-border distance from home,
 * ties broken by NE LABELRANK (more prominent first), then ID.
 */
export function introductionOrder(
  home: CountryId,
  scope: readonly CountryId[],
  distance: (a: CountryId, b: CountryId) => number,
  labelRank: (id: CountryId) => number,
): CountryId[] {
  const d = (id: CountryId) => (id === home ? -1 : Number.isNaN(distance(home, id)) ? Infinity : distance(home, id));
  return [...scope].sort((a, b) => d(a) - d(b) || labelRank(a) - labelRank(b) || a.localeCompare(b));
}

export function buildQueue(input: QueueInput): QueueSnapshot {
  const { now, cards, settings, order, daily } = input;
  const today = dayIndex(now, settings.dayStartHour);
  const tomorrow = dayStart(today + 1, settings.dayStartHour);
  const dirs = activeDirections(settings.directionMode);
  const reviewedToday = (r: CardRecord | undefined) =>
    !!r?.card.last_review && dayIndex(new Date(r.card.last_review), settings.dayStartHour) === today;

  const learningNow: { item: QueueItem; due: Date }[] = [];
  const learningLater: { item: QueueItem; due: Date }[] = [];
  const dueReviews: { item: QueueItem; r: number }[] = [];
  const ahead: { item: QueueItem; due: Date }[] = [];
  const newSiblings: QueueItem[] = [];
  const freshCountries: CountryId[] = [];
  let newCountriesToday = 0;
  let siblingsToday = 0;

  for (const countryId of order) {
    const records = DIRECTIONS.map((d) => cards.get(cardKey(countryId, d)));
    const introduced = records.filter((r): r is CardRecord => !!r);
    if (!introduced.length) {
      freshCountries.push(countryId);
      continue;
    }
    const firstDay = Math.min(...introduced.map((r) => r.introducedDay));
    if (firstDay === today) newCountriesToday++;
    else siblingsToday += introduced.filter((r) => r.introducedDay === today).length;

    for (const direction of dirs) {
      const rec = cards.get(cardKey(countryId, direction));
      const base = { key: cardKey(countryId, direction), countryId, direction, firstForCountry: false };
      if (!rec) {
        // The other direction exists: this one becomes available the day after.
        if (firstDay < today) newSiblings.push({ ...base, kind: 'new' });
        continue;
      }
      const due = new Date(rec.card.due);
      const state = cardState(rec.card);
      if (state === 'learning' || state === 'relearning') {
        const entry = { item: { ...base, kind: 'learning' as const }, due };
        if (due <= now) learningNow.push(entry);
        else if (due < tomorrow) learningLater.push(entry);
      } else if (state === 'review') {
        if (due >= tomorrow) {
          ahead.push({ item: { ...base, kind: 'ahead' }, due });
          continue;
        }
        const sib = cards.get(cardKey(countryId, sibling(direction)));
        if (settings.burySiblings && reviewedToday(sib) && !reviewedToday(rec)) continue;
        dueReviews.push({ item: { ...base, kind: 'review' }, r: input.retrievability(rec.card, now) });
      }
    }
  }

  const byDue = (a: { due: Date }, b: { due: Date }) => a.due.getTime() - b.due.getTime();
  learningNow.sort(byDue);
  learningLater.sort(byDue);
  ahead.sort(byDue);
  dueReviews.sort((a, b) => a.r - b.r);
  const reviews = dueReviews.slice(0, Math.max(0, settings.maxReviewsPerDay - daily.reviewsDone)).map((x) => x.item);

  const pausedNew = dueReviews.length > settings.pauseNewIfDueAbove;
  const allowedCountries = Math.max(0, settings.newPerDay + daily.extraNew - newCountriesToday);
  // Siblings share the same daily allowance, so switching to 'both' after a long
  // single-direction spell doesn't release hundreds of cards at once.
  const allowedSiblings = Math.max(0, settings.newPerDay + daily.extraNew - siblingsToday);
  const newItems: QueueItem[] = pausedNew
    ? []
    : [
        ...newSiblings.slice(0, allowedSiblings),
        ...freshCountries.slice(0, allowedCountries).map((countryId) => ({
          key: cardKey(countryId, dirs[0]!),
          countryId,
          direction: dirs[0]!,
          kind: 'new' as const,
          firstForCountry: true,
        })),
      ];

  return {
    learningNow: learningNow.map((x) => x.item),
    learningLater,
    reviews,
    newItems,
    ahead: ahead.map((x) => x.item),
    pausedNew,
    newCountriesToday,
    counts: { new: newItems.length, learning: learningNow.length + learningLater.length, due: reviews.length },
  };
}

/** Session-local state the picker needs. */
export interface SessionCursor {
  /** Reviews answered since the last new card. */
  reviewsSinceNew: number;
}

/**
 * Next card: learning steps that are due, then reviews with new cards
 * interleaved (one new every few reviews), then learning cards due within the
 * learn-ahead window. Null when nothing is due: the session is over.
 */
export function pickNext(q: QueueSnapshot, cursor: SessionCursor, now: Date, learnAheadMinutes: number): QueueItem | null {
  if (q.learningNow.length) return q.learningNow[0]!;
  if (q.reviews.length && q.newItems.length) {
    const every = Math.max(1, Math.min(6, Math.floor(q.reviews.length / q.newItems.length)));
    return cursor.reviewsSinceNew >= every ? q.newItems[0]! : q.reviews[0]!;
  }
  if (q.reviews.length) return q.reviews[0]!;
  if (q.newItems.length) return q.newItems[0]!;
  const soon = q.learningLater[0];
  if (soon && soon.due.getTime() <= now.getTime() + learnAheadMinutes * MINUTE) return soon.item;
  return null;
}

/** Next card for "Review ahead": learning steps first, then the soonest future reviews. */
export function pickNextAhead(q: QueueSnapshot): QueueItem | null {
  return q.learningNow[0] ?? q.ahead[0] ?? null;
}
