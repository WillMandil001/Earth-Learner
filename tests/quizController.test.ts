import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  quiz = await QuizController.create({ store, data, settings, labelRank: (id) => meta.get(id)!.labelRank });
});

afterEach(async () => {
  store.close();
  await deleteStore('quiz-test');
  clock.reset();
});

const phase = () => quiz.state;
const item = () => {
  const p = quiz.state;
  if (p.name !== 'question' && p.name !== 'reveal') throw new Error(`no item in ${p.name}`);
  return p.item;
};

describe('QuizController', () => {
  it('starts straight away with a locate question for the home country', async () => {
    expect(quiz.snapshot().counts).toEqual({ new: 5, learning: 0, due: 0 });
    quiz.start();
    expect(phase()).toMatchObject({ name: 'question', item: { countryId: 'GBR', direction: 'locate' } });
    quiz.answerLocate('GBR');
    const p = phase();
    if (p.name !== 'reveal') throw new Error();
    expect(p.result.correct).toBe(true);
    expect(p.selected).toBe(p.autoGrade);
    expect(Object.keys(p.preview)).toHaveLength(4);
    await quiz.accept();
    expect(phase()).toMatchObject({ name: 'question', item: { countryId: 'IRL', direction: 'locate' } });
    expect((await store.loadCards()).get('GBR:locate')).toBeTruthy();
    expect((await store.dump()).reviewLog[0]).toMatchObject({ key: 'GBR:locate', answer: 'GBR', grade: p.selected });
  });

  it('wrong clicks grade Again and report the distance; merges count as the parent', async () => {
    await settings.set('learning.homeCountry', 'SOM');
    quiz.start();
    expect(item().countryId).toBe('SOM');
    quiz.answerLocate('SOL'); // Somaliland counts as Somalia
    expect(phase()).toMatchObject({ name: 'reveal', result: { correct: true } });
    await quiz.accept();
    const target = item().countryId;
    quiz.answerLocate('NZL');
    const p = phase();
    if (p.name !== 'reveal') throw new Error();
    expect(p.result.correct).toBe(false);
    expect(p.autoGrade).toBe('again');
    expect(p.result.kmOff).toBe(data.distances.get('NZL', target));
    quiz.select('hard'); // override
    await quiz.accept();
    expect((await store.dump()).reviewLog.at(-1)).toMatchObject({ autoGrade: 'again', grade: 'hard', answer: 'NZL' });
  });

  it('ocean clicks are wrong with no distance', () => {
    quiz.start();
    quiz.answerLocate(null);
    expect(phase()).toMatchObject({ name: 'reveal', autoGrade: 'again', result: { kmOff: null, clickedId: null } });
  });

  it('runs a day: name cards follow the next day; typed answers are matched', async () => {
    await settings.set('learning.newPerDay', 2);
    quiz.start();
    for (let i = 0; i < 2; i++) {
      quiz.answerLocate(item().countryId);
      quiz.select('easy');
      await quiz.accept();
    }
    expect(phase().name).toBe('summary');
    clock.advance(DAY);
    expect(quiz.snapshot().newItems.map((i) => i.key)).toEqual(['GBR:name', 'IRL:name', ...quiz.snapshot().newItems.slice(2).map((i) => i.key)]);
    quiz.start();
    expect(phase()).toMatchObject({ name: 'question', item: { key: 'GBR:name' } });
    quiz.answerName('great britain');
    expect(phase()).toMatchObject({ name: 'reveal', result: { correct: true, typo: false } });
    await quiz.accept();
    expect(item().key).toBe('IRL:name');
    quiz.answerName('Irland');
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
    await settings.set('learning.newPerDay', 1);
    quiz.start();
    quiz.answerLocate('GBR');
    await quiz.accept();
    // Only GBR's learning step remains; strict learn-ahead ends the session.
    await settings.set('learning.learnAheadMinutes', 0);
    quiz.stop();
    quiz.start();
    expect(phase().name).toBe('summary');
    await quiz.learnMore();
    expect(phase()).toMatchObject({ name: 'question', item: { countryId: 'IRL', direction: 'locate' } });
  });
});
