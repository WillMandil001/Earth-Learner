import type { Direction, LayerId } from '../learn/layer';
import { MINUTE, dayIndex, dayStart } from './clock';
import { cardState, type SrsCard } from './scheduler';

/** Stored state of one card: (layer, item, direction). Cards without a record are new. */
export interface CardRecord {
  key: string;
  layerId: LayerId;
  itemId: string;
  direction: Direction;
  card: SrsCard;
  /** Day index (see clock.dayIndex) of the first answer. */
  introducedDay: number;
}

export const cardKey = (layerId: LayerId, itemId: string, direction: Direction): string => `${layerId}:${itemId}:${direction}`;
const itemKey = (layerId: LayerId, itemId: string) => `${layerId}:${itemId}`;

/** Per-layer daily counters. */
export interface LayerDaily {
  /** Review-state cards answered today (counts toward maxReviewsPerDay). */
  reviewsDone: number;
  /** Extra new items granted today by "Learn more". */
  extraNew: number;
}

/** Per-day counters kept in storage; reset when the day changes. */
export interface DailyCounters {
  day: number;
  layers: Partial<Record<LayerId, LayerDaily>>;
}

export const EMPTY_LAYER_DAILY: LayerDaily = { reviewsDone: 0, extraNew: 0 };

/** What the queue needs from one learn layer. */
export interface LayerQueueConfig {
  layerId: LayerId;
  /** Items to schedule (already introduced or not), in introduction priority order. */
  items: readonly string[];
  /** Active directions for an item; the first is introduced first. Empty = not scheduled. */
  directions(itemId: string): readonly Direction[];
  /** Prerequisites for introducing a never-seen item (e.g. its country learned first). */
  eligibleNew(itemId: string): boolean;
  newPerDay: number;
  maxReviewsPerDay: number;
  pauseNewIfDueAbove: number;
  burySiblings: boolean;
}

export type ItemKind = 'learning' | 'review' | 'new' | 'ahead';

export interface QueueItem {
  key: string;
  layerId: LayerId;
  itemId: string;
  direction: Direction;
  kind: ItemKind;
  /** First ever card for this item (as opposed to a next-day sibling). */
  firstForItem: boolean;
}

export interface QueueInput {
  now: Date;
  cards: ReadonlyMap<string, CardRecord>;
  layers: readonly LayerQueueConfig[];
  daily: DailyCounters;
  dayStartHour: number;
  retrievability(card: SrsCard, now: Date): number;
}

export interface LayerCounts {
  new: number;
  learning: number;
  due: number;
  /** New cards are held back because too many reviews are due. */
  pausedNew: boolean;
  /** Items introduced today so far. */
  newToday: number;
}

export interface QueueSnapshot {
  /** Learning/relearning cards due now, earliest first. */
  learningNow: QueueItem[];
  /** Learning/relearning cards due later today, earliest first. */
  learningLater: { item: QueueItem; due: Date }[];
  /** Review cards due today, lowest retrievability first, capped per layer. */
  reviews: QueueItem[];
  /** New cards available now, layers interleaved, each in introduction order. */
  newItems: QueueItem[];
  /** Review cards not due today, soonest first (for "Review ahead"). */
  ahead: QueueItem[];
  /** True if any layer is holding back new cards. */
  pausedNew: boolean;
  counts: { new: number; learning: number; due: number };
  byLayer: Partial<Record<LayerId, LayerCounts>>;
}

/**
 * Introduction order for a set of items: `first` (if present) leads, then by
 * `distance` ascending, ties broken by `rank` ascending, then ID.
 */
export function orderByDistance(
  items: readonly string[],
  distance: (id: string) => number,
  rank: (id: string) => number,
  first?: string,
): string[] {
  const d = (id: string) => (id === first ? -1 : Number.isNaN(distance(id)) ? Infinity : distance(id));
  return [...items].sort((a, b) => d(a) - d(b) || rank(a) - rank(b) || a.localeCompare(b));
}

/** Round-robin merge, so new cards from several layers alternate. */
function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]!);
  return out;
}

export function buildQueue(input: QueueInput): QueueSnapshot {
  const { now, cards, daily } = input;
  const today = dayIndex(now, input.dayStartHour);
  const tomorrow = dayStart(today + 1, input.dayStartHour);
  const reviewedToday = (r: CardRecord) => !!r.card.last_review && dayIndex(new Date(r.card.last_review), input.dayStartHour) === today;

  const byItem = new Map<string, CardRecord[]>();
  for (const r of cards.values()) {
    const k = itemKey(r.layerId, r.itemId);
    const list = byItem.get(k);
    if (list) list.push(r);
    else byItem.set(k, [r]);
  }

  const learningNow: { item: QueueItem; due: Date }[] = [];
  const learningLater: { item: QueueItem; due: Date }[] = [];
  const ahead: { item: QueueItem; due: Date }[] = [];
  const allReviews: { item: QueueItem; r: number }[] = [];
  const newLists: QueueItem[][] = [];
  const byLayer: Partial<Record<LayerId, LayerCounts>> = {};
  let pausedAny = false;

  for (const layer of input.layers) {
    const { layerId } = layer;
    const counters = daily.layers[layerId] ?? EMPTY_LAYER_DAILY;
    const dueReviews: { item: QueueItem; r: number }[] = [];
    const newSiblings: QueueItem[] = [];
    const fresh: QueueItem[] = [];
    let newToday = 0;
    let siblingsToday = 0;
    let learningCount = 0;

    for (const itemId of layer.items) {
      const dirs = layer.directions(itemId);
      if (!dirs.length) continue;
      const records = byItem.get(itemKey(layerId, itemId)) ?? [];
      if (!records.length) {
        if (layer.eligibleNew(itemId)) {
          fresh.push({ key: cardKey(layerId, itemId, dirs[0]!), layerId, itemId, direction: dirs[0]!, kind: 'new', firstForItem: true });
        }
        continue;
      }
      const firstDay = Math.min(...records.map((r) => r.introducedDay));
      if (firstDay === today) newToday++;
      else siblingsToday += records.filter((r) => r.introducedDay === today).length;

      for (const direction of dirs) {
        const base = { key: cardKey(layerId, itemId, direction), layerId, itemId, direction, firstForItem: false };
        const rec = records.find((r) => r.direction === direction);
        if (!rec) {
          // Another direction exists: this one becomes available the day after.
          if (firstDay < today) newSiblings.push({ ...base, kind: 'new' });
          continue;
        }
        const due = new Date(rec.card.due);
        const state = cardState(rec.card);
        if (state === 'learning' || state === 'relearning') {
          const entry = { item: { ...base, kind: 'learning' as const }, due };
          if (due <= now) {
            learningNow.push(entry);
            learningCount++;
          } else if (due < tomorrow) {
            learningLater.push(entry);
            learningCount++;
          }
        } else if (state === 'review') {
          if (due >= tomorrow) {
            ahead.push({ item: { ...base, kind: 'ahead' }, due });
            continue;
          }
          const siblingReviewed = records.some((r) => r !== rec && reviewedToday(r));
          if (layer.burySiblings && siblingReviewed && !reviewedToday(rec)) continue;
          dueReviews.push({ item: { ...base, kind: 'review' }, r: input.retrievability(rec.card, now) });
        }
      }
    }

    dueReviews.sort((a, b) => a.r - b.r);
    const reviews = dueReviews.slice(0, Math.max(0, layer.maxReviewsPerDay - counters.reviewsDone));
    allReviews.push(...reviews);
    const pausedNew = dueReviews.length > layer.pauseNewIfDueAbove;
    pausedAny ||= pausedNew;
    const allowance = layer.newPerDay + counters.extraNew;
    // Siblings share the same daily allowance, so switching to 'both' after a long
    // single-direction spell doesn't release hundreds of cards at once.
    const newItems = pausedNew
      ? []
      : [...newSiblings.slice(0, Math.max(0, allowance - siblingsToday)), ...fresh.slice(0, Math.max(0, allowance - newToday))];
    newLists.push(newItems);
    byLayer[layerId] = { new: newItems.length, learning: learningCount, due: reviews.length, pausedNew, newToday };
  }

  const byDue = (a: { due: Date }, b: { due: Date }) => a.due.getTime() - b.due.getTime();
  learningNow.sort(byDue);
  learningLater.sort(byDue);
  ahead.sort(byDue);
  allReviews.sort((a, b) => a.r - b.r);
  const newItems = interleave(newLists);
  const reviews = allReviews.map((x) => x.item);

  return {
    learningNow: learningNow.map((x) => x.item),
    learningLater,
    reviews,
    newItems,
    ahead: ahead.map((x) => x.item),
    pausedNew: pausedAny,
    counts: { new: newItems.length, learning: learningNow.length + learningLater.length, due: reviews.length },
    byLayer,
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
