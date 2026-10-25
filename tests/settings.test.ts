import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, FIELDS, normaliseSettings, updateSetting } from '../src/settings/schema';

describe('settings schema', () => {
  it('every field has a label, a description and a valid default', () => {
    for (const f of FIELDS) {
      expect(f.label, f.path).toBeTruthy();
      expect(f.description, f.path).toBeTruthy();
    }
    expect(normaliseSettings(DEFAULT_SETTINGS)).toEqual({ settings: DEFAULT_SETTINGS, replaced: [] });
  });

  it('validates ranges, types and cross-field rules', () => {
    expect(updateSetting(DEFAULT_SETTINGS, 'fsrs.requestRetention', 0.99)).toMatchObject({ ok: false });
    expect(updateSetting(DEFAULT_SETTINGS, 'fsrs.requestRetention', 0.85)).toMatchObject({ ok: true });
    expect(updateSetting(DEFAULT_SETTINGS, 'learning.newPerDay', 2.5)).toMatchObject({ ok: false });
    expect(updateSetting(DEFAULT_SETTINGS, 'learning.directionMode', 'sideways')).toMatchObject({ ok: false });
    expect(updateSetting(DEFAULT_SETTINGS, 'grading.locate.easySeconds', 20)).toMatchObject({ ok: false, error: expect.stringMatching(/below/) });
    expect(updateSetting(DEFAULT_SETTINGS, 'fsrs.learningSteps', ['1m', 'soon'])).toMatchObject({ ok: false });
    expect(updateSetting(DEFAULT_SETTINGS, 'learning.homeCountry', 'XXX', new Set(['GBR']))).toMatchObject({ ok: false });
    const r = updateSetting(DEFAULT_SETTINGS, 'learning.newPerDay', 8);
    expect(r.ok && r.settings.learning.newPerDay).toBe(8);
    expect(DEFAULT_SETTINGS.learning.newPerDay).toBe(5); // not mutated
  });

  it('normalises stored settings: keeps valid fields, replaces invalid, applies cross-checks on the whole', () => {
    const { settings, replaced } = normaliseSettings({
      learning: { newPerDay: 12, dayStartHour: 99 },
      grading: { locate: { easySeconds: 20, hardSeconds: 30 } },
      fsrs: { weights: [1, 2] },
    });
    expect(settings.learning.newPerDay).toBe(12);
    expect(settings.grading.locate).toEqual({ easySeconds: 20, hardSeconds: 30 });
    expect(settings.learning.dayStartHour).toBe(4);
    expect(settings.fsrs.weights).toEqual(DEFAULT_SETTINGS.fsrs.weights);
    expect(replaced.sort()).toEqual(['fsrs.weights', 'learning.dayStartHour']);
    expect(normaliseSettings(null).settings).toEqual(DEFAULT_SETTINGS);
  });
});
