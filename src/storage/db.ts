import { deleteDB, openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb';
import type { Direction, LayerId } from '../learn/layer';
import type { CardRecord, DailyCounters, ItemKind } from '../srs/queue';
import type { Grade, SrsReviewLog } from '../srs/scheduler';
import { migrateCardV1, migrateLogV1, migrateMetaV1, migrateSettingsV1 } from './migrations';

/** Bump when the stored shape changes, and add a step to MIGRATIONS. */
export const SCHEMA_VERSION = 2;
export const DB_NAME = 'earth-learner';
/** Demo data (?seed=demo) lives in its own database so it never touches real progress. */
export const DEMO_DB_NAME = 'earth-learner-demo';

/** One graded answer. Append-only; enough to optimise FSRS weights later. */
export interface ReviewLogEntry {
  id?: number;
  key: string;
  layerId: LayerId;
  itemId: string;
  direction: Direction;
  kind: ItemKind;
  /** ts-fsrs review log (rating, state, due, stability, difficulty, …, review time). */
  log: SrsReviewLog;
  responseMs: number;
  /** Typed text, or the clicked item/feature ID ('' for open sea / no answer). */
  answer: string;
  autoGrade: Grade;
  grade: Grade;
}

export interface MetaRecord {
  schemaVersion: number;
  daily: DailyCounters;
}

interface Schema extends DBSchema {
  cards: { key: string; value: CardRecord };
  reviewLog: { key: number; value: ReviewLogEntry; indexes: { byCard: string } };
  settings: { key: string; value: unknown };
  meta: { key: string; value: MetaRecord };
}

/** Everything in the database, as plain data. */
export interface Dump {
  settings: unknown;
  meta: MetaRecord | null;
  cards: CardRecord[];
  reviewLog: ReviewLogEntry[];
}

type UpgradeTx = IDBPTransaction<Schema, StoreNames<Schema>[], 'versionchange'>;

/** MIGRATIONS[v] upgrades a database from version v-1 to v. */
const MIGRATIONS: Record<number, (db: IDBPDatabase<Schema>, tx: UpgradeTx) => void | Promise<void>> = {
  1: (db) => {
    db.createObjectStore('cards', { keyPath: 'key' });
    db.createObjectStore('reviewLog', { keyPath: 'id', autoIncrement: true }).createIndex('byCard', 'key');
    db.createObjectStore('settings');
    db.createObjectStore('meta');
  },
  // Phase 3: cards are keyed by layer + item + direction; v1 cards are all countries.
  2: async (_db, tx) => {
    const cards = tx.objectStore('cards');
    const old: unknown[] = await cards.getAll();
    if (old.length) {
      await cards.clear();
      for (const c of old) await cards.put(migrateCardV1(c) as CardRecord);
    }
    let cursor = await tx.objectStore('reviewLog').openCursor();
    while (cursor) {
      await cursor.update(migrateLogV1(cursor.value) as ReviewLogEntry);
      cursor = await cursor.continue();
    }
    const meta = tx.objectStore('meta');
    const m: unknown = await meta.get('meta');
    if (m) await meta.put(migrateMetaV1(m) as MetaRecord, 'meta');
    const settings = tx.objectStore('settings');
    const s: unknown = await settings.get('settings');
    if (s) await settings.put(migrateSettingsV1(s), 'settings');
  },
};

const STORES = ['cards', 'reviewLog', 'settings', 'meta'] as const;

/** Persistence for the learning loop. The rest of the app only sees this interface. */
export interface Store {
  loadCards(): Promise<Map<string, CardRecord>>;
  /** Save a graded answer atomically: card state, review log entry and counters. */
  saveAnswer(card: CardRecord, entry: ReviewLogEntry, meta: MetaRecord): Promise<void>;
  loadSettings(): Promise<unknown>;
  saveSettings(settings: unknown): Promise<void>;
  loadMeta(): Promise<MetaRecord | null>;
  saveMeta(meta: MetaRecord): Promise<void>;
  dump(): Promise<Dump>;
  /** Replace everything in one transaction. */
  replaceAll(dump: Dump): Promise<void>;
  clearProgress(): Promise<void>;
  /**
   * Re-file cards under new keys (e.g. moving them to another layer). `rekey`
   * returns the new record, or null to leave it; the card's review log follows.
   * Returns how many cards moved.
   */
  rekeyCards(rekey: <T extends CardRecord | ReviewLogEntry>(rec: T) => T | null): Promise<number>;
  close(): void;
}

export async function openStore(name = DB_NAME, version = SCHEMA_VERSION): Promise<Store> {
  const db = await openDB<Schema>(name, version, {
    async upgrade(db, oldVersion, newVersion, tx) {
      for (let v = oldVersion + 1; v <= (newVersion ?? version); v++) await MIGRATIONS[v]?.(db, tx);
    },
  });

  return {
    async loadCards() {
      const all = await db.getAll('cards');
      return new Map(all.map((c) => [c.key, c]));
    },
    async saveAnswer(card, entry, meta) {
      const tx = db.transaction(['cards', 'reviewLog', 'meta'], 'readwrite');
      await Promise.all([
        tx.objectStore('cards').put(card),
        tx.objectStore('reviewLog').add(entry),
        tx.objectStore('meta').put(meta, 'meta'),
        tx.done,
      ]);
    },
    loadSettings: () => db.get('settings', 'settings'),
    saveSettings: async (s) => void (await db.put('settings', s, 'settings')),
    loadMeta: async () => (await db.get('meta', 'meta')) ?? null,
    saveMeta: async (m) => void (await db.put('meta', m, 'meta')),
    async dump() {
      const tx = db.transaction([...STORES], 'readonly');
      const [settings, meta, cards, reviewLog] = await Promise.all([
        tx.objectStore('settings').get('settings'),
        tx.objectStore('meta').get('meta'),
        tx.objectStore('cards').getAll(),
        tx.objectStore('reviewLog').getAll(),
      ]);
      await tx.done;
      return { settings: settings ?? null, meta: meta ?? null, cards, reviewLog };
    },
    async replaceAll(d) {
      const tx = db.transaction([...STORES], 'readwrite');
      await Promise.all(STORES.map((s) => tx.objectStore(s).clear()));
      const writes: Promise<unknown>[] = [
        ...d.cards.map((c) => tx.objectStore('cards').put(c)),
        ...d.reviewLog.map((r) => tx.objectStore('reviewLog').put(r)),
      ];
      if (d.settings) writes.push(tx.objectStore('settings').put(d.settings, 'settings'));
      if (d.meta) writes.push(tx.objectStore('meta').put(d.meta, 'meta'));
      await Promise.all([...writes, tx.done]);
    },
    async clearProgress() {
      const tx = db.transaction(['cards', 'reviewLog', 'meta'], 'readwrite');
      await Promise.all([tx.objectStore('cards').clear(), tx.objectStore('reviewLog').clear(), tx.objectStore('meta').clear(), tx.done]);
    },
    async rekeyCards(rekey) {
      const tx = db.transaction(['cards', 'reviewLog'], 'readwrite');
      const cards = tx.objectStore('cards');
      let moved = 0;
      for (const c of await cards.getAll()) {
        const next = rekey(c);
        if (!next) continue;
        await cards.delete(c.key);
        await cards.put(next);
        moved++;
      }
      if (moved) {
        let cursor = await tx.objectStore('reviewLog').openCursor();
        while (cursor) {
          const next = rekey(cursor.value);
          if (next) await cursor.update(next);
          cursor = await cursor.continue();
        }
      }
      await tx.done;
      return moved;
    },
    close: () => db.close(),
  };
}

export function deleteStore(name: string): Promise<void> {
  return deleteDB(name);
}
