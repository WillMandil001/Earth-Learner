import { HOME_COUNTRY } from '../config';
import { SCOPES, type ScopeId } from '../quiz/data';
import { DEFAULT_SCHEDULER_PARAMS, parseSteps, validateWeights, type SchedulerParams } from '../srs/scheduler';
import type { CountryId } from '../types';

export type Direction = 'locate' | 'name';
export type DirectionMode = Direction | 'both';
export type TypoTolerance = 'off' | 'normal' | 'lenient';

export interface LearningSettings {
  directionMode: DirectionMode;
  homeCountry: CountryId;
  scope: ScopeId;
  newPerDay: number;
  maxReviewsPerDay: number;
  pauseNewIfDueAbove: number;
  /** When nothing else is due, learning cards due within this many minutes are shown early. */
  learnAheadMinutes: number;
  burySiblings: boolean;
  dayStartHour: number;
}

export interface TimeThresholds {
  easySeconds: number;
  hardSeconds: number;
}

export interface GradingSettings {
  locate: TimeThresholds;
  name: TimeThresholds;
  typoTolerance: TypoTolerance;
}

export interface Settings {
  learning: LearningSettings;
  fsrs: SchedulerParams;
  grading: GradingSettings;
  display: { showTimer: boolean };
}

export const DEFAULT_SETTINGS: Settings = {
  learning: {
    directionMode: 'both',
    homeCountry: HOME_COUNTRY,
    scope: 'sovereign',
    newPerDay: 5,
    maxReviewsPerDay: 200,
    pauseNewIfDueAbove: 50,
    learnAheadMinutes: 20,
    burySiblings: true,
    dayStartHour: 4,
  },
  fsrs: DEFAULT_SCHEDULER_PARAMS,
  grading: {
    locate: { easySeconds: 5, hardSeconds: 15 },
    name: { easySeconds: 6, hardSeconds: 15 },
    typoTolerance: 'normal',
  },
  display: { showTimer: true },
};

type Validate = (value: unknown, all: Settings) => string | null;

interface BaseField {
  /** Dot path into Settings, e.g. "learning.newPerDay". */
  path: string;
  label: string;
  description: string;
  section: 'learning' | 'scheduler' | 'grading';
  validate?: Validate;
}

export type FieldSpec = BaseField &
  (
    | { kind: 'select'; options: { value: string; label: string }[] }
    | { kind: 'number'; min: number; max: number; step: number; integer?: boolean }
    | { kind: 'slider'; min: number; max: number; step: number }
    | { kind: 'boolean' }
    | { kind: 'steps' }
    | { kind: 'weights' }
    | { kind: 'country' }
  );

const thresholdOrder =
  (dir: Direction): Validate =>
  (_v, all) =>
    all.grading[dir].easySeconds < all.grading[dir].hardSeconds ? null : 'The Easy limit must be below the Hard limit';

/** Every editable setting, in display order. The settings panel renders from this list. */
export const FIELDS: FieldSpec[] = [
  {
    path: 'learning.directionMode',
    section: 'learning',
    kind: 'select',
    label: 'Question directions',
    description: 'Which questions you get. Switching never deletes progress.',
    options: [
      { value: 'both', label: 'Both (find and name)' },
      { value: 'locate', label: 'Find it on the globe' },
      { value: 'name', label: 'Name the highlighted country' },
    ],
  },
  {
    path: 'learning.homeCountry',
    section: 'learning',
    kind: 'country',
    label: 'Home country',
    description: 'New countries are introduced outward from here, nearest first.',
  },
  {
    path: 'learning.scope',
    section: 'learning',
    kind: 'select',
    label: 'Countries to learn',
    description: 'The set of countries that become questions.',
    options: SCOPES.map((s) => ({ value: s, label: s === 'sovereign' ? '197 sovereign states (UN members + 4)' : s })),
  },
  {
    path: 'learning.newPerDay',
    section: 'learning',
    kind: 'number',
    min: 0,
    max: 200,
    step: 1,
    integer: true,
    label: 'New countries per day',
    description: 'How many countries you first meet each day.',
  },
  {
    path: 'learning.maxReviewsPerDay',
    section: 'learning',
    kind: 'number',
    min: 0,
    max: 9999,
    step: 10,
    integer: true,
    label: 'Maximum reviews per day',
    description: 'Due reviews beyond this wait until tomorrow.',
  },
  {
    path: 'learning.pauseNewIfDueAbove',
    section: 'learning',
    kind: 'number',
    min: 0,
    max: 9999,
    step: 5,
    integer: true,
    label: 'Pause new countries above this many due',
    description: 'If more reviews than this are due, no new countries until you catch up.',
  },
  {
    path: 'learning.learnAheadMinutes',
    section: 'learning',
    kind: 'number',
    min: 0,
    max: 120,
    step: 5,
    integer: true,
    label: 'Learn-ahead window (minutes)',
    description: 'When nothing else is due, show short-step cards this early instead of ending the session.',
  },
  {
    path: 'learning.burySiblings',
    section: 'learning',
    kind: 'boolean',
    label: 'Bury siblings',
    description: "After a country is reviewed in one direction, its other direction waits until tomorrow.",
  },
  {
    path: 'learning.dayStartHour',
    section: 'learning',
    kind: 'number',
    min: 0,
    max: 23,
    step: 1,
    integer: true,
    label: 'New day starts at (hour)',
    description: 'Daily limits reset at this local hour, so late nights count as the same day.',
  },
  {
    path: 'fsrs.requestRetention',
    section: 'scheduler',
    kind: 'slider',
    min: 0.7,
    max: 0.97,
    step: 0.01,
    label: 'Desired retention',
    description: 'Higher = more reviews, fewer forgotten.',
  },
  {
    path: 'fsrs.maximumInterval',
    section: 'scheduler',
    kind: 'number',
    min: 1,
    max: 36500,
    step: 1,
    integer: true,
    label: 'Maximum interval (days)',
    description: 'The longest gap allowed between reviews of one card.',
  },
  {
    path: 'fsrs.learningSteps',
    section: 'scheduler',
    kind: 'steps',
    label: 'Learning steps',
    description: 'Short re-tests for new cards, e.g. "1m 10m". Empty = let FSRS decide.',
  },
  {
    path: 'fsrs.relearningSteps',
    section: 'scheduler',
    kind: 'steps',
    label: 'Relearning steps',
    description: 'Short re-tests after you forget a card, e.g. "10m".',
  },
  {
    path: 'fsrs.enableShortTerm',
    section: 'scheduler',
    kind: 'boolean',
    label: 'Short-term scheduling',
    description: 'Use the learning steps above. Off = every answer is scheduled in whole days.',
  },
  {
    path: 'fsrs.enableFuzz',
    section: 'scheduler',
    kind: 'boolean',
    label: 'Fuzz',
    description: 'Randomise intervals slightly so cards learned together drift apart.',
  },
  {
    path: 'fsrs.weights',
    section: 'scheduler',
    kind: 'weights',
    label: 'Weights',
    description: 'FSRS model parameters (17, 19 or 21 numbers). Only change these if you have optimised them.',
  },
  {
    path: 'grading.locate.easySeconds',
    section: 'grading',
    kind: 'number',
    min: 1,
    max: 120,
    step: 1,
    label: 'Find it: Easy if faster than (s)',
    description: 'A correct click within this time is graded Easy.',
    validate: thresholdOrder('locate'),
  },
  {
    path: 'grading.locate.hardSeconds',
    section: 'grading',
    kind: 'number',
    min: 1,
    max: 300,
    step: 1,
    label: 'Find it: Hard if slower than (s)',
    description: 'A correct click after this time is graded Hard; in between is Good.',
    validate: thresholdOrder('locate'),
  },
  {
    path: 'grading.name.easySeconds',
    section: 'grading',
    kind: 'number',
    min: 1,
    max: 120,
    step: 1,
    label: 'Name it: Easy if faster than (s)',
    description: 'A correct answer within this time is graded Easy.',
    validate: thresholdOrder('name'),
  },
  {
    path: 'grading.name.hardSeconds',
    section: 'grading',
    kind: 'number',
    min: 1,
    max: 300,
    step: 1,
    label: 'Name it: Hard if slower than (s)',
    description: 'A correct answer after this time is graded Hard; in between is Good.',
    validate: thresholdOrder('name'),
  },
  {
    path: 'grading.typoTolerance',
    section: 'grading',
    kind: 'select',
    label: 'Typo tolerance',
    description: 'How many spelling slips a typed name may have. Typo answers count as Hard at best.',
    options: [
      { value: 'off', label: 'Off (exact spelling)' },
      { value: 'normal', label: 'Normal (1 slip for 5–9 letters, 2 for 10+)' },
      { value: 'lenient', label: 'Lenient (1 slip from 4 letters, 2 from 8)' },
    ],
  },
  {
    path: 'display.showTimer',
    section: 'grading',
    kind: 'boolean',
    label: 'Show timer',
    description: 'Show a small elapsed-time counter during questions. Timing is graded either way.',
  },
];

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}

function setPath<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.');
  const clone = structuredClone(obj) as Record<string, unknown>;
  let o = clone;
  for (const k of keys.slice(0, -1)) o = o[k] as Record<string, unknown>;
  o[keys[keys.length - 1]!] = value;
  return clone as T;
}

/** Type/range check for one field value (before cross-field checks). */
function checkField(f: FieldSpec, v: unknown, countries: ReadonlySet<CountryId> | null): string | null {
  switch (f.kind) {
    case 'select':
      return f.options.some((o) => o.value === v) ? null : 'Not one of the options';
    case 'number':
    case 'slider': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'Must be a number';
      if (v < f.min || v > f.max) return `Must be between ${f.min} and ${f.max}`;
      if (f.kind === 'number' && f.integer && !Number.isInteger(v)) return 'Must be a whole number';
      return null;
    }
    case 'boolean':
      return typeof v === 'boolean' ? null : 'Must be on or off';
    case 'steps':
      return Array.isArray(v) && parseSteps(v.join(' ')).ok ? null : 'Invalid steps';
    case 'weights':
      return Array.isArray(v) ? validateWeights(v as number[]) : 'Must be a list of numbers';
    case 'country':
      return typeof v === 'string' && (!countries || countries.has(v)) ? null : 'Unknown country';
  }
}

/**
 * Set one field, returning the new settings or an error. `countries` (the
 * valid home countries) is optional so pure tests can skip it.
 */
export function updateSetting(
  settings: Settings,
  path: string,
  value: unknown,
  countries: ReadonlySet<CountryId> | null = null,
): { ok: true; settings: Settings } | { ok: false; error: string } {
  const f = FIELDS.find((x) => x.path === path);
  if (!f) return { ok: false, error: `Unknown setting ${path}` };
  const err = checkField(f, value, countries);
  if (err) return { ok: false, error: err };
  const next = setPath(settings, path, value);
  const cross = f.validate?.(value, next);
  return cross ? { ok: false, error: cross } : { ok: true, settings: next };
}

/**
 * Settings from storage or an import: fill missing fields with defaults and
 * replace invalid ones, reporting which were replaced.
 */
export function normaliseSettings(raw: unknown): { settings: Settings; replaced: string[] } {
  let settings = structuredClone(DEFAULT_SETTINGS);
  const replaced: string[] = [];
  // Type/range checks first, then cross-field checks on the combined result.
  for (const f of FIELDS) {
    const v = getPath(raw, f.path);
    if (v === undefined) continue;
    if (checkField(f, v, null)) replaced.push(f.path);
    else settings = setPath(settings, f.path, v);
  }
  for (const f of FIELDS) {
    if (f.validate?.(getPath(settings, f.path), settings)) {
      settings = setPath(settings, f.path, getPath(DEFAULT_SETTINGS, f.path));
      replaced.push(f.path);
    }
  }
  return { settings, replaced };
}
