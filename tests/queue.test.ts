import { beforeEach, describe, expect, it } from 'vitest';
import type { Direction, LayerId } from '../src/learn/layer';
import { CountryLayer } from '../src/layers/country/countryLayer';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings/schema';
import { DAY, HOUR, MINUTE, dayIndex, dayStart } from '../src/srs/clock';
import {
  buildQueue,
  cardKey,
  pickNext,
  type CardRecord,
  type DailyCounters,
  type LayerQueueConfig,
  type QueueInput,
} from '../src/srs/queue';
import { Scheduler, type Grade } from '../src/srs/scheduler';
import { countryData, quizData } from './fixtures';

const data = quizData();
const meta = countryData().meta;
const countries = new CountryLayer(data, meta);
const sched = new Scheduler();
const T0 = new Date(2026, 0, 10, 12, 0); // local noon

let cards: Map<string, CardRecord>;
let settings: Settings;
let order: string[];

beforeEach(() => {
  cards = new Map();
  settings = structuredClone(DEFAULT_SETTINGS);
  order = countries.introductionOrder(settings);
});

const country = () => settings.layers.country;

const daily = (now: Date, layers: DailyCounters['layers'] = {}): DailyCounters => ({ day: dayIndex(now, 4), layers });

/** A second, fake layer with three directions, to exercise the generic queue. */
const fake = (over: Partial<LayerQueueConfig> = {}): LayerQueueConfig => ({
  layerId: 'city',
  items: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'],
  directions: () => ['locate', 'name', 'capitalOf'],
  eligibleNew: () => true,
  newPerDay: 2,
  maxReviewsPerDay: 100,
  pauseNewIfDueAbove: 50,
  burySiblings: true,
  ...over,
});

const input = (now: Date, extra: Partial<QueueInput> = {}): QueueInput => ({
  now,
  cards,
  layers: [countries.queueConfig({ settings, cards })],
  daily: daily(now),
  dayStartHour: 4,
  retrievability: (c, t) => sched.retrievability(c, t),
  ...extra,
});

function answer(itemId: string, direction: Direction, now: Date, grade: Grade, layerId: LayerId = 'country'): CardRecord {
  const key = cardKey(layerId, itemId, direction);
  const prev = cards.get(key);
  const out = sched.review(prev?.card ?? sched.newCard(now), now, grade);
  const rec = { key, layerId, itemId, direction, card: out.card, introducedDay: prev?.introducedDay ?? dayIndex(now, 4) };
  cards.set(key, rec);
  return rec;
}

/** A card in review state due exactly at `due`. */
function reviewCard(itemId: string, direction: Direction, due: Date, introducedDay = dayIndex(due, 4) - 10, layerId: LayerId = 'country') {
  const start = new Date(due.getTime() - 10 * DAY);
  const rec = answer(itemId, direction, start, 'easy', layerId);
  rec.card = { ...rec.card, due };
  rec.introducedDay = introducedDay;
}

describe('introduction order', () => {
  it('starts at home and works outward', () => {
    expect(order[0]).toBe('GBR');
    expect(order[1]).toBe('IRL');
    const pos = (id: string) => order.indexOf(id);
    for (const near of ['FRA', 'BEL', 'NLD']) expect(pos(near)).toBeLessThan(8);
    for (const far of ['NZL', 'TON', 'FJI', 'CHL']) expect(pos(far)).toBeGreaterThan(150);
    expect(new Set(order).size).toBe(197);
  });

  it('can start from any home country', () => {
    settings.global.homeCountry = 'JPN';
    const fromJapan = countries.introductionOrder(settings);
    expect(fromJapan[0]).toBe('JPN');
    expect(fromJapan.slice(1, 5)).toEqual(expect.arrayContaining(['KOR', 'RUS']));
  });
});

describe('new cards', () => {
  it('offers newPerDay countries, locate first in both mode', () => {
    const q = buildQueue(input(T0));
    expect(q.newItems.map((i) => i.itemId)).toEqual(order.slice(0, 5));
    expect(q.newItems.every((i) => i.direction === 'locate' && i.firstForItem && i.layerId === 'country')).toBe(true);
    expect(q.counts).toEqual({ new: 5, learning: 0, due: 0 });
    expect(q.newItems[0]!.key).toBe('country:GBR:locate');
  });

  it('enforces the daily limit, with Learn more adding a batch', () => {
    for (const id of order.slice(0, 5)) answer(id, 'locate', T0, 'good');
    expect(buildQueue(input(T0)).newItems).toEqual([]);
    expect(buildQueue(input(T0)).byLayer.country?.newToday).toBe(5);
    const more = buildQueue(input(T0, { daily: daily(T0, { country: { reviewsDone: 0, extraNew: 5 } }) }));
    expect(more.newItems.map((i) => i.itemId)).toEqual(order.slice(5, 10));
  });

  it('introduces the name card the next day (sibling spacing)', () => {
    answer('GBR', 'locate', T0, 'good');
    const today = buildQueue(input(T0));
    expect(today.newItems.some((i) => i.key === 'country:GBR:name')).toBe(false);
    const tomorrow = new Date(T0.getTime() + DAY);
    const next = buildQueue(input(tomorrow));
    expect(next.newItems[0]).toMatchObject({ key: 'country:GBR:name', kind: 'new', firstForItem: false });
  });

  it('pauses new cards when too many reviews are due', () => {
    country().pauseNewIfDueAbove = 3;
    const due = new Date(T0.getTime() - HOUR);
    for (const id of order.slice(10, 13)) reviewCard(id, 'locate', due);
    expect(buildQueue(input(T0)).pausedNew).toBe(false);
    reviewCard(order[13]!, 'locate', due);
    const q = buildQueue(input(T0));
    expect(q.pausedNew).toBe(true);
    expect(q.byLayer.country?.pausedNew).toBe(true);
    expect(q.newItems).toEqual([]);
    expect(q.counts.due).toBe(4);
  });
});

describe('sibling allowance', () => {
  it('caps next-day siblings at the daily new limit', () => {
    const due = new Date(T0.getTime() + 30 * DAY);
    for (const id of order.slice(0, 12)) reviewCard(id, 'locate', due, dayIndex(T0, 4) - 3);
    const q = buildQueue(input(T0));
    expect(q.newItems.filter((i) => !i.firstForItem)).toHaveLength(5);
    for (const i of q.newItems.filter((x) => !x.firstForItem)) answer(i.itemId, i.direction, T0, 'good');
    expect(buildQueue(input(T0)).newItems.filter((i) => !i.firstForItem)).toHaveLength(0);
  });
});

describe('reviews', () => {
  it('orders due reviews by retrievability, lowest first, and caps them', () => {
    reviewCard('FRA', 'locate', new Date(T0.getTime() - 5 * DAY));
    reviewCard('DEU', 'locate', new Date(T0.getTime() - HOUR));
    reviewCard('ESP', 'locate', new Date(T0.getTime() + DAY * 3)); // not due
    const q = buildQueue(input(T0));
    expect(q.reviews.map((i) => i.itemId)).toEqual(['FRA', 'DEU']);
    expect(q.ahead.map((i) => i.itemId)).toEqual(['ESP']);
    country().maxReviewsPerDay = 1;
    expect(buildQueue(input(T0)).reviews.map((i) => i.itemId)).toEqual(['FRA']);
    expect(buildQueue(input(T0, { daily: daily(T0, { country: { reviewsDone: 1, extraNew: 0 } }) })).reviews).toEqual([]);
  });

  it('buries the sibling once one direction has been reviewed today', () => {
    const due = new Date(T0.getTime() - HOUR);
    reviewCard('FRA', 'locate', due);
    reviewCard('FRA', 'name', due);
    expect(buildQueue(input(T0)).reviews.map((i) => i.key).sort()).toEqual(['country:FRA:locate', 'country:FRA:name']);
    answer('FRA', 'locate', T0, 'good');
    expect(buildQueue(input(T0)).reviews.map((i) => i.key)).toEqual([]);
    const tomorrow = new Date(T0.getTime() + DAY);
    expect(buildQueue(input(tomorrow)).reviews.map((i) => i.key)).toContain('country:FRA:name');
    country().burySiblings = false;
    expect(buildQueue(input(T0)).reviews.map((i) => i.key)).toEqual(['country:FRA:name']);
  });
});

describe('learning steps', () => {
  it('re-inserts a failed card when its step is due, learning ahead if nothing else', () => {
    answer('GBR', 'locate', T0, 'again'); // due in 1m
    let q = buildQueue(input(T0));
    expect(q.learningNow).toEqual([]);
    expect(q.learningLater.map((x) => x.item.key)).toEqual(['country:GBR:locate']);
    expect(pickNext(q, { reviewsSinceNew: 0 }, T0, 20)?.kind).toBe('new'); // other new cards first
    country().newPerDay = 1;
    q = buildQueue(input(T0));
    expect(pickNext(q, { reviewsSinceNew: 0 }, T0, 20)?.key).toBe('country:GBR:locate'); // learn ahead
    expect(pickNext(q, { reviewsSinceNew: 0 }, T0, 0)).toBeNull(); // strict: session over
    const later = new Date(T0.getTime() + MINUTE);
    q = buildQueue(input(later));
    expect(q.learningNow.map((i) => i.key)).toEqual(['country:GBR:locate']);
    expect(pickNext(q, { reviewsSinceNew: 0 }, later, 0)?.key).toBe('country:GBR:locate');
  });
});

describe('day boundary', () => {
  it('starts the day at dayStartHour local time', () => {
    const lateNight = new Date(2026, 0, 11, 3, 59);
    const morning = new Date(2026, 0, 11, 4, 0);
    expect(dayIndex(lateNight, 4)).toBe(dayIndex(T0, 4));
    expect(dayIndex(morning, 4)).toBe(dayIndex(T0, 4) + 1);
    expect(dayStart(dayIndex(T0, 4) + 1, 4)).toEqual(morning);
  });

  it('counts a review due at 03:00 tomorrow as due today, and new limits reset at 04:00', () => {
    reviewCard('JPN', 'locate', new Date(2026, 0, 11, 3, 0));
    expect(buildQueue(input(T0)).reviews.map((i) => i.itemId)).toEqual(['JPN']);
    for (const id of order.slice(0, 5)) answer(id, 'locate', T0, 'good');
    const at359 = new Date(2026, 0, 11, 3, 59);
    expect(buildQueue(input(at359)).byLayer.country?.newToday).toBe(5);
    expect(buildQueue(input(new Date(2026, 0, 11, 4, 0))).byLayer.country?.newToday).toBe(0);
  });
});

describe('direction mode', () => {
  it('filters cards without touching stored state', () => {
    const due = new Date(T0.getTime() - HOUR);
    reviewCard('FRA', 'locate', due);
    reviewCard('DEU', 'name', due);
    const snapshot = structuredClone([...cards]);
    country().directionMode = 'locate';
    let q = buildQueue(input(T0));
    expect(q.reviews.map((i) => i.key)).toEqual(['country:FRA:locate']);
    expect(q.newItems.every((i) => i.direction === 'locate')).toBe(true);
    country().directionMode = 'name';
    q = buildQueue(input(T0));
    expect(q.reviews.map((i) => i.key)).toEqual(['country:DEU:name']);
    expect(q.newItems[0]).toMatchObject({ direction: 'name' });
    // FRA's name card is a next-day sibling of an old card, so it is available now.
    expect(q.newItems.map((i) => i.key)).toContain('country:FRA:name');
    country().directionMode = 'both';
    expect(buildQueue(input(T0)).reviews.map((i) => i.key).sort()).toEqual(['country:DEU:name', 'country:FRA:locate']);
    expect([...cards]).toEqual(snapshot);
  });
});

describe('interleaving', () => {
  it('mixes new cards in among reviews', () => {
    const due = new Date(T0.getTime() - HOUR);
    for (const id of order.slice(20, 32)) reviewCard(id, 'locate', due);
    country().directionMode = 'locate';
    country().newPerDay = 3;
    const q = buildQueue(input(T0));
    expect(q.counts).toMatchObject({ due: 12, new: 3 });
    const seq: string[] = [];
    let since = 0;
    const reviews = [...q.reviews];
    const news = [...q.newItems];
    while (reviews.length || news.length) {
      const next = pickNext({ ...q, reviews, newItems: news }, { reviewsSinceNew: since }, T0, 0)!;
      seq.push(next.kind);
      if (next.kind === 'new') {
        news.shift();
        since = 0;
      } else {
        reviews.shift();
        since++;
      }
    }
    // One new roughly every few reviews: never first, never all saved for the end.
    expect(seq[0]).toBe('review');
    expect(seq.indexOf('new')).toBeLessThanOrEqual(4);
    expect(seq.filter((k) => k === 'new')).toHaveLength(3);
    expect(seq.slice(-3)).not.toEqual(['new', 'new', 'new']);
    const gaps = seq.join(',').split('new').map((run) => run.split(',').filter(Boolean).length);
    expect(Math.max(...gaps.slice(0, -1))).toBeLessThanOrEqual(6);
  });
});

describe('multiple layers', () => {
  const both = (cfg = fake()) => [countries.queueConfig({ settings, cards }), cfg];

  it('applies new and review limits per layer', () => {
    const q = buildQueue(input(T0, { layers: both() }));
    expect(q.byLayer.country?.new).toBe(5);
    expect(q.byLayer.city?.new).toBe(2);
    expect(q.newItems.filter((i) => i.layerId === 'city').map((i) => i.itemId)).toEqual(['c1', 'c2']);

    const due = new Date(T0.getTime() - HOUR);
    for (const id of ['c1', 'c2', 'c3']) reviewCard(id, 'locate', due, undefined, 'city');
    for (const id of ['FRA', 'DEU']) reviewCard(id, 'locate', due);
    const capped = buildQueue(input(T0, { layers: both(fake({ maxReviewsPerDay: 1 })) }));
    expect(capped.byLayer.city?.due).toBe(1);
    expect(capped.byLayer.country?.due).toBe(2);
    expect(capped.reviews).toHaveLength(3);
  });

  it('pauses new cards per layer', () => {
    const due = new Date(T0.getTime() - HOUR);
    for (const id of ['c1', 'c2', 'c3']) reviewCard(id, 'locate', due, undefined, 'city');
    const q = buildQueue(input(T0, { layers: both(fake({ pauseNewIfDueAbove: 2 })) }));
    expect(q.byLayer.city?.pausedNew).toBe(true);
    expect(q.byLayer.country?.pausedNew).toBe(false);
    expect(q.newItems.every((i) => i.layerId === 'country')).toBe(true);
  });

  it('interleaves new cards from different layers', () => {
    const q = buildQueue(input(T0, { layers: both() }));
    expect(q.newItems.slice(0, 4).map((i) => i.layerId)).toEqual(['country', 'city', 'country', 'city']);
  });

  it('buries all other directions of the same item, but not other items or layers', () => {
    const due = new Date(T0.getTime() - HOUR);
    for (const d of ['locate', 'name', 'capitalOf'] as const) reviewCard('c1', d, due, undefined, 'city');
    reviewCard('c2', 'locate', due, undefined, 'city');
    reviewCard('FRA', 'locate', due);
    answer('c1', 'capitalOf', T0, 'good', 'city');
    const keys = buildQueue(input(T0, { layers: both() })).reviews.map((i) => i.key).sort();
    expect(keys).toEqual(['city:c2:locate', 'country:FRA:locate']);
  });

  it('only introduces items whose prerequisites are met', () => {
    const q = buildQueue(input(T0, { layers: [fake({ eligibleNew: (id) => id === 'c3' })] }));
    expect(q.newItems.map((i) => i.itemId)).toEqual(['c3']);
  });
});
