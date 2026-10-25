import { describe, expect, it } from 'vitest';
import { DEFAULT_SCHEDULER_PARAMS, GRADES, Scheduler, cardState, formatInterval, parseSteps, validateWeights } from '../src/srs/scheduler';

const now = new Date(2026, 0, 10, 12, 0);

describe('Scheduler', () => {
  it('passes settings through to ts-fsrs', () => {
    const s = new Scheduler({
      ...DEFAULT_SCHEDULER_PARAMS,
      requestRetention: 0.8,
      maximumInterval: 365,
      learningSteps: ['2m', '20m'],
      relearningSteps: ['5m'],
      enableShortTerm: false,
      enableFuzz: true,
    });
    const p = s.parameters;
    expect(p.request_retention).toBe(0.8);
    expect(p.maximum_interval).toBe(365);
    expect(p.learning_steps).toEqual(['2m', '20m']);
    expect(p.relearning_steps).toEqual(['5m']);
    expect(p.enable_short_term).toBe(false);
    expect(p.enable_fuzz).toBe(true);
    expect(p.w.length).toBe(21);
  });

  it('previews all four grades with intervals', () => {
    const s = new Scheduler();
    const preview = s.preview(s.newCard(now), now);
    expect(Object.keys(preview).sort()).toEqual([...GRADES].sort());
    expect(preview.again.interval).toBe('1m');
    expect(preview.good.interval).toBe('10m');
    for (const g of GRADES) expect(preview[g].card.due.getTime()).toBeGreaterThan(now.getTime());
  });

  it('higher desired retention gives shorter review intervals', () => {
    const intervalAt = (requestRetention: number) => {
      const s = new Scheduler({ ...DEFAULT_SCHEDULER_PARAMS, requestRetention });
      let card = s.review(s.newCard(now), now, 'easy').card;
      expect(cardState(card)).toBe('review');
      card = s.review(card, card.due, 'good').card;
      return card.scheduled_days;
    };
    expect(intervalAt(0.97)).toBeLessThan(intervalAt(0.8));
  });

  it('reconfiguring affects later reviews', () => {
    const s = new Scheduler();
    s.configure({ ...DEFAULT_SCHEDULER_PARAMS, learningSteps: ['3m'] });
    expect(s.preview(s.newCard(now), now).again.interval).toBe('3m');
  });
});

describe('helpers', () => {
  it('parses and rejects steps', () => {
    expect(parseSteps('1m 10m, 1h')).toEqual({ ok: true, steps: ['1m', '10m', '1h'] });
    expect(parseSteps('')).toEqual({ ok: true, steps: [] });
    expect(parseSteps('10 minutes').ok).toBe(false);
    expect(parseSteps('0m').ok).toBe(false);
  });

  it('validates weights', () => {
    expect(validateWeights([...DEFAULT_SCHEDULER_PARAMS.weights])).toBeNull();
    expect(validateWeights([1, 2, 3])).toMatch(/length/);
    expect(validateWeights([...DEFAULT_SCHEDULER_PARAMS.weights.slice(0, 20), NaN])).toMatch(/numbers/);
  });

  it('formats intervals', () => {
    const t = now.getTime();
    expect(formatInterval(now, new Date(t + 30_000))).toBe('<1m');
    expect(formatInterval(now, new Date(t + 10 * 60_000))).toBe('10m');
    expect(formatInterval(now, new Date(t + 3 * 3_600_000))).toBe('3h');
    expect(formatInterval(now, new Date(t + 3 * 86_400_000))).toBe('3d');
    expect(formatInterval(now, new Date(t + 45 * 86_400_000))).toBe('1.5mo');
    expect(formatInterval(now, new Date(t + 800 * 86_400_000))).toBe('2.2y');
  });
});
