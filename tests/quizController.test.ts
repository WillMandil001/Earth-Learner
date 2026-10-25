import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CountryLayer } from '../src/layers/country/countryLayer';
import { QuizController } from '../src/quiz/QuizController';
import { SettingsStore } from '../src/settings/store';
import { DAY, clock } from '../src/srs/clock';
import { deleteStore, openStore, type Store } from '../src/storage/db';
import { countryData, quizData } from './fixtures';

const data = quizData();
const meta = countryData().meta;
let store: Store;
let settings: SettingsStore;
let quiz: QuizController;

beforeEach(async () => {
  clock.set(new Date(2026, 0, 10, 12, 0));
  store = await openStore('quiz-test');
  settings = await SettingsStore.load(store, new Set(data.scopes.sovereign));
  quiz = await QuizController.create({ store, settings, layers: [new CountryLayer(data, meta)] });
});

afterEach(async () => {
  store.close();
  await deleteStore('quiz-test');
  clock.reset();
});

const phase = () => quiz.state;
const click = (countryId: string | null) => quiz.answerClick({ lonLat: null, countryId, cityId: null });
const item = () => {
  const p = quiz.state;
  if (p.name !== 'question' && p.name !== 'reveal') throw new Error(`no item in ${p.name}`);
  return p.item;
};

describe('QuizController', () => {
  it('starts straight away with a locate question for the home country', async () => {
    expect(quiz.snapshot().counts).toEqual({ new: 5, learning: 0, due: 0 });
    quiz.start();
    expect(phase()).toMatchObject({ name: 'question', item: { itemId: 'GBR', direction: 'locate' } });
    click('GBR');
    const p = phase();
    if (p.name !== 'reveal') throw new Error();
    expect(p.result.correct).toBe(true);
    expect(p.selected).toBe(p.autoGrade);
    expect(Object.keys(p.preview)).toHaveLength(4);
    await quiz.accept();
    expect(phase()).toMatchObject({ name: 'question', item: { itemId: 'IRL', direction: 'locate' } });
    expect((await store.loadCards()).get('country:GBR:locate')).toBeTruthy();
    expect((await store.dump()).reviewLog[0]).toMatchObject({ key: 'country:GBR:locate', answer: 'GBR', grade: p.selected });
  });

  it('wrong clicks grade Again and report the distance; merges count as the parent', async () => {
    await settings.set('global.homeCountry', 'SOM');
    quiz.start();
    expect(item().itemId).toBe('SOM');
    click('SOL'); // Somaliland counts as Somalia
    expect(phase()).toMatchObject({ name: 'reveal', result: { correct: true } });
    await quiz.accept();
    const target = item().itemId;
    click('NZL');
    const p = phase();
    if (p.name !== 'reveal') throw new Error();
    expect(p.result.correct).toBe(false);
    expect(p.autoGrade).toBe('again');
    expect(p.result.distanceKm).toBe(data.distances.get('NZL', target));
    quiz.select('hard'); // override
    await quiz.accept();
    expect((await store.dump()).reviewLog.at(-1)).toMatchObject({ autoGrade: 'again', grade: 'hard', answer: 'NZL' });
  });

  it('ocean clicks are wrong with no distance', () => {
    quiz.start();
    click(null);
    expect(phase()).toMatchObject({ name: 'reveal', autoGrade: 'again', result: { distanceKm: null, clickedItemId: null } });
  });

  it('runs a day: name cards follow the next day; typed answers are matched', async () => {
    await settings.set('layers.country.newPerDay', 2);
    quiz.start();
    for (let i = 0; i < 2; i++) {
      click(item().itemId);
      quiz.select('easy');
      await quiz.accept();
    }
    expect(phase().name).toBe('summary');
    clock.advance(DAY);
    expect(quiz.snapshot().newItems.map((i) => i.key)).toEqual(['country:GBR:name', 'country:IRL:name', ...quiz.snapshot().newItems.slice(2).map((i) => i.key)]);
    quiz.start();
    expect(phase()).toMatchObject({ name: 'question', item: { key: 'country:GBR:name' } });
    quiz.answerTyped('great britain');
    expect(phase()).toMatchObject({ name: 'reveal', result: { correct: true, typo: false } });
    await quiz.accept();
    expect(item().key).toBe('country:IRL:name');
    quiz.answerTyped('Irland');
    expect(phase()).toMatchObject({ name: 'reveal', autoGrade: 'hard', result: { correct: true, typo: true } });
  });

  it("gave up = Again; can't grade twice", async () => {
    quiz.start();
    quiz.giveUp();
    expect(phase()).toMatchObject({ name: 'reveal', autoGrade: 'again', result: { gaveUp: true } });
    await Promise.all([quiz.accept(), quiz.accept()]);
    expect((await store.dump()).reviewLog).toHaveLength(1);
  });

  it('learn more grants another batch', async () => {
    await settings.set('layers.country.newPerDay', 1);
    quiz.start();
    click('GBR');
    await quiz.accept();
    // Only GBR's learning step remains; strict learn-ahead ends the session.
    await settings.set('global.learnAheadMinutes', 0);
    quiz.stop();
    quiz.start();
    expect(phase().name).toBe('summary');
    await quiz.learnMore();
    expect(phase()).toMatchObject({ name: 'question', item: { itemId: 'IRL', direction: 'locate' } });
  });

  it('the layer filter limits a session to one layer', async () => {
    await settings.set('global.layerFilter', 'city');
    expect(quiz.activeLayers()).toEqual([]);
    expect(quiz.snapshot().counts).toEqual({ new: 0, learning: 0, due: 0 });
    await settings.set('global.layerFilter', 'country');
    expect(quiz.snapshot().counts.new).toBe(5);
    await settings.set('layers.country.enabled', false);
    expect(quiz.activeLayers()).toEqual([]);
  });
});
