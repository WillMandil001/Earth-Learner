import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, updateSetting } from '../src/settings/schema';
import { dayIndex } from '../src/srs/clock';
import { cardKey, type CardRecord } from '../src/srs/queue';
import { Scheduler, type Grade } from '../src/srs/scheduler';
import { SCHEMA_VERSION, deleteStore, openStore, type Store } from '../src/storage/db';
import { exportJson, parseImport } from '../src/storage/export';

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
        const rec: CardRecord = { key: cardKey(id, direction), countryId: id, direction, card, introducedDay: dayIndex(t, 4) };
        await s.saveAnswer(
          rec,
          { key: rec.key, countryId: id, direction, kind: 'new', log: out.log, responseMs: 1234 + n, answer: n ? 'x' : id, autoGrade: grade, grade },
          { schemaVersion: SCHEMA_VERSION, daily: { day: dayIndex(t, 4), reviewsDone: n, extraNew: 0 } },
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
    expect(cards.get('IRL:name')!.card.due).toBeInstanceOf(Date);
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
