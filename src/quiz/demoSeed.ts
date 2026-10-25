import { DAY, HOUR, dayIndex } from '../srs/clock';
import { cardKey, type CardRecord, type ItemKind } from '../srs/queue';
import { Scheduler, cardState, type Grade } from '../srs/scheduler';
import type { Settings } from '../settings/schema';
import { SCHEMA_VERSION, type Dump, type ReviewLogEntry } from '../storage/db';
import type { CountryId } from '../types';

/** Deterministic PRNG (mulberry32), so the demo history is the same every time. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEMO_COUNTRIES = 40;

/**
 * A plausible country progress history for the first 40 countries in the introduction
 * order: older countries are well known, recent ones still in learning, and
 * some reviews are overdue. Built by replaying answers through the real scheduler.
 */
export function generateDemoDump(now: Date, order: readonly CountryId[], settings: Settings): Dump {
  const random = rng(42);
  const scheduler = new Scheduler(settings.fsrs);
  const h = settings.global.dayStartHour;
  const pick = (): Grade => {
    const r = random();
    return r < 0.12 ? 'again' : r < 0.27 ? 'hard' : r < 0.85 ? 'good' : 'easy';
  };
  const cards: CardRecord[] = [];
  const reviewLog: ReviewLogEntry[] = [];

  order.slice(0, DEMO_COUNTRIES).forEach((countryId, i) => {
    // Five countries a day, the newest introduced today.
    const daysAgo = Math.floor((DEMO_COUNTRIES - 1 - i) / 5);
    const start = new Date(now.getTime() - daysAgo * DAY - (1 + random() * 6) * HOUR);
    for (const direction of ['locate', 'name'] as const) {
      let t = direction === 'locate' ? start : new Date(start.getTime() + DAY);
      if (t > now) continue;
      // Some cards stop being reviewed a few days early, so they are overdue now.
      const stopAt = random() < 0.3 ? now.getTime() - random() * 4 * DAY : now.getTime();
      let card = scheduler.newCard(t);
      let introducedDay = -1;
      while (t.getTime() <= stopAt) {
        const before = cardState(card);
        const grade = pick();
        const out = scheduler.review(card, t, grade);
        if (introducedDay < 0) introducedDay = dayIndex(t, h);
        const kind: ItemKind = before === 'new' ? 'new' : before === 'review' ? 'review' : 'learning';
        reviewLog.push({
          key: cardKey('country', countryId, direction),
          layerId: 'country',
          itemId: countryId,
          direction,
          kind,
          log: out.log,
          responseMs: Math.round(2000 + random() * 12000),
          answer: grade === 'again' ? '' : countryId,
          autoGrade: grade,
          grade,
        });
        card = out.card;
        // Next answer when due, a little late on average.
        t = new Date(card.due.getTime() + random() * (cardState(card) === 'review' ? 10 * HOUR : 2 * 60_000));
      }
      if (introducedDay >= 0) {
        cards.push({ key: cardKey('country', countryId, direction), layerId: 'country', itemId: countryId, direction, card, introducedDay });
      }
    }
  });

  reviewLog.forEach((r, i) => (r.id = i + 1));
  return {
    settings,
    meta: { schemaVersion: SCHEMA_VERSION, daily: { day: dayIndex(now, h), layers: {} } },
    cards,
    reviewLog,
  };
}
