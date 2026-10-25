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
    expect(updateSetting(DEFAULT_SETTINGS, 'layers.country.newPerDay', 2.5)).toMatchObject({ ok: false });
    expect(updateSetting(DEFAULT_SETTINGS, 'layers.city.directionMode', 'sideways')).toMatchObject({ ok: false });
    expect(updateSetting(DEFAULT_SETTINGS, 'layers.country.grading.locate.easySeconds', 20)).toMatchObject({ ok: false, error: expect.stringMatching(/below/) });
    expect(updateSetting(DEFAULT_SETTINGS, 'fsrs.learningSteps', ['1m', 'soon'])).toMatchObject({ ok: false });
    expect(updateSetting(DEFAULT_SETTINGS, 'global.homeCountry', 'XXX', new Set(['GBR']))).toMatchObject({ ok: false });
    const r = updateSetting(DEFAULT_SETTINGS, 'layers.city.newPerDay', 8);
    expect(r.ok && r.settings.layers.city.newPerDay).toBe(8);
    expect(DEFAULT_SETTINGS.layers.city.newPerDay).toBe(5); // not mutated
    expect(updateSetting(DEFAULT_SETTINGS, 'layers.city.majorPopThreshold', 50_000)).toMatchObject({ ok: false });
    expect(updateSetting(DEFAULT_SETTINGS, 'global.layerFilter', 'city')).toMatchObject({ ok: true });
    expect(updateSetting(DEFAULT_SETTINGS, 'global.layerFilter', 'rivers')).toMatchObject({ ok: false });
  });

  it('normalises stored settings: keeps valid fields, replaces invalid, applies cross-checks on the whole', () => {
    const { settings, replaced } = normaliseSettings({
      global: { dayStartHour: 99 },
      layers: { country: { newPerDay: 12, grading: { locate: { easySeconds: 20, hardSeconds: 30 } } } },
      fsrs: { weights: [1, 2] },
    });
    expect(settings.layers.country.newPerDay).toBe(12);
    expect(settings.layers.country.grading.locate).toEqual({ easySeconds: 20, hardSeconds: 30 });
    expect(settings.global.dayStartHour).toBe(4);
    expect(settings.fsrs.weights).toEqual(DEFAULT_SETTINGS.fsrs.weights);
    expect(replaced.sort()).toEqual(['fsrs.weights', 'global.dayStartHour']);
    expect(normaliseSettings(null).settings).toEqual(DEFAULT_SETTINGS);
  });

  it('upgrades Phase 2 (v1) settings into the per-layer structure', () => {
    const { settings } = normaliseSettings({
      learning: { homeCountry: 'JPN', newPerDay: 9, directionMode: 'name', dayStartHour: 6 },
      grading: { typoTolerance: 'off' },
      display: { showTimer: false },
    });
    expect(settings.global).toMatchObject({ homeCountry: 'JPN', dayStartHour: 6, showTimer: false });
    expect(settings.layers.country).toMatchObject({ newPerDay: 9, directionMode: 'name' });
    expect(settings.layers.country.grading.typoTolerance).toBe('off');
    expect(settings.layers.city).toEqual(DEFAULT_SETTINGS.layers.city);
  });
});
