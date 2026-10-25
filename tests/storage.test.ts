import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normaliseSettings, updateSetting } from '../src/settings/schema';
import { dayIndex } from '../src/srs/clock';
import { cardKey, type CardRecord } from '../src/srs/queue';
import { Scheduler, type Grade } from '../src/srs/scheduler';
import { SCHEMA_VERSION, deleteStore, openStore, type Store } from '../src/storage/db';
import { exportJson, parseImport } from '../src/storage/export';
import { openDB } from 'idb';

let store: Store | null = null;
afterEach(async () => {
  store?.close();
  store = null;
  await deleteStore('test-db');
});

async function populated(): Promise<Store> {
  const s = await openStore('test-db');
  const r = updateSetting(DEFAULT_SETTINGS, 'fsrs.requestRetention', 0.85);
  if (!r.ok) throw new Error(r.error);
  await s.saveSettings(r.settings);
  const sched = new Scheduler();
  let t = new Date(2026, 0, 1, 12);
  const grades: Grade[] = ['good', 'again', 'easy', 'hard'];
  for (const [i, id] of ['GBR', 'IRL', 'FRA'].entries()) {
    for (const direction of ['locate', 'name'] as const) {
      let card = sched.newCard(t);
      for (let n = 0; n < 3; n++) {
        const grade = grades[(i + n) % 4]!;
        const out = sched.review(card, t, grade);
        card = out.card;
        const rec: CardRecord = { key: cardKey('country', id, direction), layerId: 'country', itemId: id, direction, card, introducedDay: dayIndex(t, 4) };
        await s.saveAnswer(
          rec,
          { key: rec.key, layerId: 'country', itemId: id, direction, kind: 'new', log: out.log, responseMs: 1234 + n, answer: n ? 'x' : id, autoGrade: grade, grade },
          { schemaVersion: SCHEMA_VERSION, daily: { day: dayIndex(t, 4), layers: { country: { reviewsDone: n, extraNew: 0 } } } },
        );
        t = new Date(t.getTime() + 3_600_000);
      }
    }
  }
  return s;
}

const withoutStamp = (json: string) => {
  const o = JSON.parse(json);
  delete o.exportedAt;
  return o;
};

describe('storage', () => {
  it('export → reset → import round-trips exactly', async () => {
    store = await populated();
    const before = exportJson(await store.dump(), new Date());
    const parsedBefore = JSON.parse(before);
    expect(parsedBefore.cards).toHaveLength(6);
    expect(parsedBefore.reviewLog).toHaveLength(18);

    await store.clearProgress();
    await store.saveSettings(DEFAULT_SETTINGS);
    expect((await store.loadCards()).size).toBe(0);

    const parsed = parseImport(before);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.summary).toMatchObject({ cards: 6, reviews: 18, hasSettings: true });
    await store.replaceAll(parsed.dump);

    const after = exportJson(await store.dump(), new Date());
    expect(withoutStamp(after)).toEqual(withoutStamp(before));
    const cards = await store.loadCards();
    expect(cards.get('country:IRL:name')!.card.due).toBeInstanceOf(Date);
  });

  it('reset keeps settings but clears progress', async () => {
    store = await populated();
    await store.clearProgress();
    const d = await store.dump();
    expect(d.cards).toEqual([]);
    expect(d.reviewLog).toEqual([]);
    expect(d.meta).toBeNull();
    expect((d.settings as typeof DEFAULT_SETTINGS).fsrs.requestRetention).toBe(0.85);
  });
});

describe('import validation', () => {
  const good = async () => {
    store = await populated();
    return JSON.parse(exportJson(await store.dump(), new Date()));
  };

  it('rejects non-JSON, foreign files and other schema versions', async () => {
    expect(parseImport('not json')).toMatchObject({ ok: false, error: expect.stringMatching(/JSON/) });
    expect(parseImport('{"hello":1}')).toMatchObject({ ok: false, error: expect.stringMatching(/not an Earth Learner/) });
    const f = await good();
    expect(parseImport(JSON.stringify({ ...f, schemaVersion: 99 }))).toMatchObject({ ok: false, error: expect.stringMatching(/version 99/) });
  });

  it('rejects malformed cards and logs', async () => {
    const f = await good();
    const badDate = structuredClone(f);
    badDate.cards[0].card.due = 'yesterday-ish';
    expect(parseImport(JSON.stringify(badDate))).toMatchObject({ ok: false, error: expect.stringMatching(/cards\[0\]\.card\.due/) });
    const badKey = structuredClone(f);
    badKey.cards[1].key = 'GBR:sideways';
    expect(parseImport(JSON.stringify(badKey))).toMatchObject({ ok: false });
    const dup = structuredClone(f);
    dup.cards.push(dup.cards[0]);
    expect(parseImport(JSON.stringify(dup))).toMatchObject({ ok: false, error: expect.stringMatching(/duplicate/) });
    const badGrade = structuredClone(f);
    badGrade.reviewLog[0].grade = 'perfect';
    expect(parseImport(JSON.stringify(badGrade))).toMatchObject({ ok: false, error: expect.stringMatching(/grade/) });
  });

  it('does not write anything when validation fails', async () => {
    const f = await good();
    f.cards[2].card.stability = 'lots';
    expect(parseImport(JSON.stringify(f)).ok).toBe(false);
    expect((await store!.loadCards()).size).toBe(6);
  });
});

/** Phase 2 (schema v1) records, exactly as Phase 2 stored and exported them. */
function v1Fixture() {
  const sched = new Scheduler();
  const t = new Date(2026, 0, 1, 12);
  const cards: unknown[] = [];
  const logs: unknown[] = [];
  let id = 1;
  for (const countryId of ['GBR', 'FRA', 'CIV']) {
    for (const direction of ['locate', 'name'] as const) {
      const a = sched.review(sched.newCard(t), t, 'good');
      const b = sched.review(a.card, a.card.due, 'easy');
      cards.push({ key: `${countryId}:${direction}`, countryId, direction, card: b.card, introducedDay: dayIndex(t, 4) });
      for (const out of [a, b]) {
        logs.push({ id: id++, key: `${countryId}:${direction}`, countryId, direction, kind: 'new', log: out.log, responseMs: 2000, answer: countryId, autoGrade: 'good', grade: 'easy' });
      }
    }
  }
  const settings = {
    learning: { directionMode: 'locate', homeCountry: 'FRA', scope: 'sovereign', newPerDay: 7, maxReviewsPerDay: 150, pauseNewIfDueAbove: 40, learnAheadMinutes: 10, showIntroCards: true, burySiblings: false, dayStartHour: 5 },
    fsrs: { ...DEFAULT_SETTINGS.fsrs, requestRetention: 0.85 },
    grading: { locate: { easySeconds: 4, hardSeconds: 12 }, name: { easySeconds: 7, hardSeconds: 20 }, typoTolerance: 'lenient' },
    display: { showTimer: false },
  };
  const meta = { schemaVersion: 1, daily: { day: dayIndex(t, 4), reviewsDone: 3, extraNew: 5 } };
  return { cards, logs, settings, meta };
}

function expectMigrated(dump: { cards: CardRecord[]; reviewLog: { key: string; layerId: string; itemId: string; log: unknown }[]; settings: unknown; meta: unknown }, v1: ReturnType<typeof v1Fixture>) {
  expect(dump.cards).toHaveLength(6);
  const gbr = dump.cards.find((c) => c.key === 'country:GBR:name')!;
  const orig = (v1.cards as { key: string; card: unknown }[]).find((c) => c.key === 'GBR:name')!;
  expect(gbr).toMatchObject({ layerId: 'country', itemId: 'GBR', direction: 'name' });
  expect(gbr.card).toEqual(orig.card);
  expect(dump.reviewLog).toHaveLength(12);
  expect(dump.reviewLog.every((r) => r.layerId === 'country' && r.key === `country:${r.itemId}:${r.key.split(':')[2]}`)).toBe(true);
  expect(dump.reviewLog.map((r) => r.log)).toEqual((v1.logs as { log: unknown }[]).map((l) => l.log));
  expect(dump.meta).toMatchObject({ schemaVersion: 2, daily: { layers: { country: { reviewsDone: 3, extraNew: 5 } } } });
  const s = normaliseSettings(dump.settings).settings;
  expect(s.global).toMatchObject({ homeCountry: 'FRA', dayStartHour: 5, learnAheadMinutes: 10, showTimer: false });
  expect(s.layers.country).toMatchObject({ directionMode: 'locate', newPerDay: 7, maxReviewsPerDay: 150, pauseNewIfDueAbove: 40, burySiblings: false });
  expect(s.layers.country.grading).toEqual({ locate: { easySeconds: 4, hardSeconds: 12 }, name: { easySeconds: 7, hardSeconds: 20 }, typoTolerance: 'lenient' });
  expect(s.fsrs.requestRetention).toBe(0.85);
}

describe('migration v1 → v2', () => {
  it('upgrades a v1 IndexedDB losslessly', async () => {
    const v1 = v1Fixture();
    // Create the database exactly as Phase 2 did (schema version 1) and fill it.
    (await openStore('test-db', 1)).close();
    const raw = await openDB('test-db', 1);
    const tx = raw.transaction(['cards', 'reviewLog', 'settings', 'meta'], 'readwrite');
    for (const c of v1.cards) await tx.objectStore('cards').put(c);
    for (const l of v1.logs) await tx.objectStore('reviewLog').put(l);
    await tx.objectStore('settings').put(v1.settings, 'settings');
    await tx.objectStore('meta').put(v1.meta, 'meta');
    await tx.done;
    raw.close();

    store = await openStore('test-db');
    expectMigrated(await store.dump(), v1);
    expect((await store.loadCards()).get('country:CIV:locate')?.card.due).toBeInstanceOf(Date);
  });

  it('imports a v1 export file', async () => {
    const v1 = v1Fixture();
    const file = JSON.stringify({ app: 'earth-learner', schemaVersion: 1, exportedAt: new Date().toISOString(), settings: v1.settings, meta: v1.meta, cards: v1.cards, reviewLog: v1.logs });
    const parsed = parseImport(file);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.summary.upgradedFrom).toBe(1);
    store = await openStore('test-db');
    await store.replaceAll(parsed.dump);
    expectMigrated(await store.dump(), v1);
  });
});
