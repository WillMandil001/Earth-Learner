import { DIRECTIONS, type CardRecord } from '../srs/queue';
import { GRADES, type SrsCard, type SrsReviewLog } from '../srs/scheduler';
import { normaliseSettings } from '../settings/schema';
import { SCHEMA_VERSION, type Dump, type MetaRecord, type ReviewLogEntry } from './db';

export const EXPORT_APP_ID = 'earth-learner';

export interface ExportFile {
  app: typeof EXPORT_APP_ID;
  schemaVersion: number;
  exportedAt: string;
  settings: unknown;
  meta: MetaRecord | null;
  cards: CardRecord[];
  reviewLog: ReviewLogEntry[];
}

/** JSON text for a download. Dates serialise as ISO strings. */
export function exportJson(dump: Dump, now: Date): string {
  const file: ExportFile = { app: EXPORT_APP_ID, schemaVersion: SCHEMA_VERSION, exportedAt: now.toISOString(), ...dump };
  return JSON.stringify(file, null, 1);
}

export interface ImportSummary {
  cards: number;
  reviews: number;
  exportedAt: string;
  hasSettings: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (o: Obj, k: string) => typeof o[k] === 'number' && Number.isFinite(o[k]);

function toDate(v: unknown, what: string): Date {
  const d = typeof v === 'string' || v instanceof Date ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) throw new Error(`${what} is not a valid date`);
  return d;
}

const CARD_NUMBERS = ['stability', 'difficulty', 'elapsed_days', 'scheduled_days', 'learning_steps', 'reps', 'lapses', 'state'];

function parseCard(v: unknown, i: number): CardRecord {
  const where = `cards[${i}]`;
  if (!isObj(v) || !isObj(v.card)) throw new Error(`${where} is malformed`);
  const { key, countryId, direction, introducedDay, card } = v;
  if (typeof countryId !== 'string' || !DIRECTIONS.includes(direction as never) || key !== `${countryId}:${direction}`) {
    throw new Error(`${where} has an invalid key/country/direction`);
  }
  if (typeof introducedDay !== 'number' || !Number.isInteger(introducedDay)) throw new Error(`${where}.introducedDay is invalid`);
  for (const k of CARD_NUMBERS) if (!num(card, k)) throw new Error(`${where}.card.${k} is missing`);
  if (![0, 1, 2, 3].includes(card.state as number)) throw new Error(`${where}.card.state is invalid`);
  const parsed = { ...card, due: toDate(card.due, `${where}.card.due`) } as unknown as SrsCard;
  if (card.last_review != null) parsed.last_review = toDate(card.last_review, `${where}.card.last_review`);
  else delete parsed.last_review;
  return { key, countryId, direction: direction as CardRecord['direction'], introducedDay, card: parsed };
}

function parseLog(v: unknown, i: number): ReviewLogEntry {
  const where = `reviewLog[${i}]`;
  if (!isObj(v) || !isObj(v.log)) throw new Error(`${where} is malformed`);
  const { log } = v;
  if (typeof v.key !== 'string' || typeof v.countryId !== 'string' || !DIRECTIONS.includes(v.direction as never)) {
    throw new Error(`${where} has an invalid card reference`);
  }
  if (!GRADES.includes(v.grade as never) || !GRADES.includes(v.autoGrade as never)) throw new Error(`${where} has an invalid grade`);
  if (!num(v, 'responseMs') || typeof v.answer !== 'string') throw new Error(`${where} is missing answer data`);
  if (!num(log, 'rating') || !num(log, 'state')) throw new Error(`${where}.log is missing rating/state`);
  const entry = {
    ...v,
    log: { ...log, due: toDate(log.due, `${where}.log.due`), review: toDate(log.review, `${where}.log.review`) } as unknown as SrsReviewLog,
  } as ReviewLogEntry;
  if (v.id !== undefined && !Number.isInteger(v.id)) throw new Error(`${where}.id is invalid`);
  return entry;
}

function parseMeta(v: unknown): MetaRecord | null {
  if (v === null || v === undefined) return null;
  if (!isObj(v) || !isObj(v.daily) || !num(v.daily, 'day') || !num(v.daily, 'reviewsDone') || !num(v.daily, 'extraNew')) {
    throw new Error('meta is malformed');
  }
  return { schemaVersion: SCHEMA_VERSION, daily: { day: v.daily.day as number, reviewsDone: v.daily.reviewsDone as number, extraNew: v.daily.extraNew as number } };
}

/**
 * Validate an export file completely before anything is written.
 * Returns the data to store and a summary for the confirmation dialog.
 */
export function parseImport(text: string): { ok: true; dump: Dump; summary: ImportSummary } | { ok: false; error: string } {
  try {
    const raw: unknown = JSON.parse(text);
    if (!isObj(raw) || raw.app !== EXPORT_APP_ID) return { ok: false, error: 'This is not an Earth Learner export file.' };
    if (raw.schemaVersion !== SCHEMA_VERSION) {
      return { ok: false, error: `Unsupported file version ${String(raw.schemaVersion)} (this app reads version ${SCHEMA_VERSION}).` };
    }
    if (!Array.isArray(raw.cards) || !Array.isArray(raw.reviewLog)) return { ok: false, error: 'The file has no cards or review log.' };
    const cards = raw.cards.map(parseCard);
    const reviewLog = raw.reviewLog.map(parseLog);
    if (new Set(cards.map((c) => c.key)).size !== cards.length) return { ok: false, error: 'The file contains duplicate cards.' };
    const settings = raw.settings == null ? null : normaliseSettings(raw.settings).settings;
    const dump: Dump = { settings, meta: parseMeta(raw.meta), cards, reviewLog };
    return {
      ok: true,
      dump,
      summary: { cards: cards.length, reviews: reviewLog.length, exportedAt: String(raw.exportedAt ?? ''), hasSettings: !!settings },
    };
  } catch (e) {
    return { ok: false, error: e instanceof SyntaxError ? 'The file is not valid JSON.' : e instanceof Error ? e.message : String(e) };
  }
}
