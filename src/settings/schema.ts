import { HOME_COUNTRY } from '../config';
import type { Direction, LayerId } from '../learn/layer';
import { SCOPES, type ScopeId } from '../quiz/data';
import { DEFAULT_SCHEDULER_PARAMS, parseSteps, validateWeights, type SchedulerParams } from '../srs/scheduler';
import type { CountryId } from '../types';

export type { Direction };
export type DirectionMode = 'locate' | 'name' | 'both';
export type TypoTolerance = 'off' | 'normal' | 'lenient';
export type LayerFilter = 'all' | LayerId;

export interface TimeThresholds {
  easySeconds: number;
  hardSeconds: number;
}

export interface LayerGrading {
  locate: TimeThresholds;
  name: TimeThresholds;
  typoTolerance: TypoTolerance;
}

/** Settings every learn layer has. */
export interface CommonLayerSettings {
  enabled: boolean;
  directionMode: DirectionMode;
  newPerDay: number;
  maxReviewsPerDay: number;
  pauseNewIfDueAbove: number;
  burySiblings: boolean;
  grading: LayerGrading;
}

export interface CountryLayerSettings extends CommonLayerSettings {
  scope: ScopeId;
}

export interface CityTiers {
  capitals: boolean;
  major: boolean;
  extended: boolean;
}

export interface CityLayerSettings extends CommonLayerSettings {
  capitalOf: boolean;
  tiers: CityTiers;
  majorPopThreshold: number;
  majorMaxPerCountry: number;
  homeCountryPopThreshold: number;
  requireCountryFirst: boolean;
  showCountryInPrompt: boolean;
  showDotsDuringFind: boolean;
  showCountryLabelsDuringName: boolean;
  maxLocateKm: number;
  preciseKm: number;
}

export interface GlobalSettings {
  homeCountry: CountryId;
  dayStartHour: number;
  /** When nothing else is due, learning cards due within this many minutes are shown early. */
  learnAheadMinutes: number;
  showTimer: boolean;
  /** Which layers a Learn session draws from. */
  layerFilter: LayerFilter;
}

export interface Settings {
  global: GlobalSettings;
  /** Shared by all layers for now; per-layer parameters would live under layers.* later. */
  fsrs: SchedulerParams;
  layers: { country: CountryLayerSettings; city: CityLayerSettings };
}

/** Lowest population included in cities.json, so thresholds can't go below it. */
export const CITY_POP_FLOOR = 100_000;

export const DEFAULT_SETTINGS: Settings = {
  global: { homeCountry: HOME_COUNTRY, dayStartHour: 4, learnAheadMinutes: 20, showTimer: true, layerFilter: 'all' },
  fsrs: DEFAULT_SCHEDULER_PARAMS,
  layers: {
    country: {
      enabled: true,
      directionMode: 'both',
      newPerDay: 5,
      maxReviewsPerDay: 200,
      pauseNewIfDueAbove: 50,
      burySiblings: true,
      grading: { locate: { easySeconds: 5, hardSeconds: 15 }, name: { easySeconds: 6, hardSeconds: 15 }, typoTolerance: 'normal' },
      scope: 'sovereign',
    },
    city: {
      enabled: true,
      directionMode: 'both',
      newPerDay: 5,
      maxReviewsPerDay: 200,
      pauseNewIfDueAbove: 50,
      burySiblings: true,
      grading: { locate: { easySeconds: 6, hardSeconds: 18 }, name: { easySeconds: 6, hardSeconds: 15 }, typoTolerance: 'normal' },
      capitalOf: false,
      tiers: { capitals: true, major: true, extended: false },
      majorPopThreshold: 1_000_000,
      majorMaxPerCountry: 8,
      homeCountryPopThreshold: 200_000,
      requireCountryFirst: true,
      showCountryInPrompt: true,
      showDotsDuringFind: false,
      showCountryLabelsDuringName: false,
      maxLocateKm: 300,
      preciseKm: 75,
    },
  },
};

type Validate = (value: unknown, all: Settings) => string | null;

interface BaseField {
  /** Dot path into Settings, e.g. "layers.country.newPerDay". */
  path: string;
  label: string;
  description: string;
  /** 'global', 'scheduler', or 'layer:<id>'. */
  section: string;
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
  (layer: LayerId, dir: 'locate' | 'name'): Validate =>
  (_v, all) => {
    const t = all.layers[layer].grading[dir];
    return t.easySeconds < t.hardSeconds ? null : 'The Easy limit must be below the Hard limit';
  };

const GLOBAL_FIELDS: FieldSpec[] = [
  {
    path: 'global.homeCountry',
    section: 'global',
    kind: 'country',
    label: 'Home country',
    description: 'New countries and cities are introduced outward from here, nearest first.',
  },
  {
    path: 'global.dayStartHour',
    section: 'global',
    kind: 'number',
    min: 0,
    max: 23,
    step: 1,
    integer: true,
    label: 'New day starts at (hour)',
    description: 'Daily limits reset at this local hour, so late nights count as the same day.',
  },
  {
    path: 'global.learnAheadMinutes',
    section: 'global',
    kind: 'number',
    min: 0,
    max: 120,
    step: 5,
    integer: true,
    label: 'Learn-ahead window (minutes)',
    description: 'When nothing else is due, show short-step cards this early instead of ending the session.',
  },
  {
    path: 'global.showTimer',
    section: 'global',
    kind: 'boolean',
    label: 'Show timer',
    description: 'Show a small elapsed-time counter during questions. Timing is graded either way.',
  },
];

const SCHEDULER_FIELDS: FieldSpec[] = [
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
];

/** Fields every layer has, under layers.<id>.*. */
function commonLayerFields(layer: LayerId, noun: string): FieldSpec[] {
  const p = (k: string) => `layers.${layer}.${k}`;
  const section = `layer:${layer}`;
  return [
    { path: p('enabled'), section, kind: 'boolean', label: 'Learn this layer', description: `Include ${noun} in Learn sessions.` },
    {
      path: p('directionMode'),
      section,
      kind: 'select',
      label: 'Question directions',
      description: 'Which questions you get. Switching never deletes progress.',
      options: [
        { value: 'both', label: 'Both (find and name)' },
        { value: 'locate', label: 'Find it on the globe' },
        { value: 'name', label: 'Name it' },
      ],
    },
    {
      path: p('newPerDay'),
      section,
      kind: 'number',
      min: 0,
      max: 200,
      step: 1,
      integer: true,
      label: 'New per day',
      description: `How many new ${noun} you first meet each day.`,
    },
    {
      path: p('maxReviewsPerDay'),
      section,
      kind: 'number',
      min: 0,
      max: 9999,
      step: 10,
      integer: true,
      label: 'Maximum reviews per day',
      description: 'Due reviews beyond this wait until tomorrow.',
    },
    {
      path: p('pauseNewIfDueAbove'),
      section,
      kind: 'number',
      min: 0,
      max: 9999,
      step: 5,
      integer: true,
      label: 'Pause new above this many due',
      description: `If more ${noun} reviews than this are due, no new ${noun} until you catch up.`,
    },
    {
      path: p('burySiblings'),
      section,
      kind: 'boolean',
      label: 'Bury siblings',
      description: 'After one question about an item, its other questions wait until tomorrow.',
    },
    {
      path: p('grading.locate.easySeconds'),
      section,
      kind: 'number',
      min: 1,
      max: 120,
      step: 1,
      label: 'Find it: Easy if faster than (s)',
      description: 'A correct click within this time is graded Easy.',
      validate: thresholdOrder(layer, 'locate'),
    },
    {
      path: p('grading.locate.hardSeconds'),
      section,
      kind: 'number',
      min: 1,
      max: 300,
      step: 1,
      label: 'Find it: Hard if slower than (s)',
      description: 'A correct click after this time is graded Hard; in between is Good.',
      validate: thresholdOrder(layer, 'locate'),
    },
    {
      path: p('grading.name.easySeconds'),
      section,
      kind: 'number',
      min: 1,
      max: 120,
      step: 1,
      label: 'Name it: Easy if faster than (s)',
      description: 'A correct typed answer within this time is graded Easy.',
      validate: thresholdOrder(layer, 'name'),
    },
    {
      path: p('grading.name.hardSeconds'),
      section,
      kind: 'number',
      min: 1,
      max: 300,
      step: 1,
      label: 'Name it: Hard if slower than (s)',
      description: 'A correct typed answer after this time is graded Hard; in between is Good.',
      validate: thresholdOrder(layer, 'name'),
    },
    {
      path: p('grading.typoTolerance'),
      section,
      kind: 'select',
      label: 'Typo tolerance',
      description: 'How many spelling slips a typed name may have. Typo answers count as Hard at best.',
      options: [
        { value: 'off', label: 'Off (exact spelling)' },
        { value: 'normal', label: 'Normal (1 slip for 5–9 letters, 2 for 10+)' },
        { value: 'lenient', label: 'Lenient (1 slip from 4 letters, 2 from 8)' },
      ],
    },
  ];
}

const COUNTRY_FIELDS: FieldSpec[] = [
  ...commonLayerFields('country', 'countries'),
  {
    path: 'layers.country.scope',
    section: 'layer:country',
    kind: 'select',
    label: 'Countries to learn',
    description: 'The set of countries that become questions.',
    options: SCOPES.map((s) => ({ value: s, label: s === 'sovereign' ? '197 sovereign states (UN members + 4)' : s })),
  },
];

const cityNumber = (
  k: string,
  label: string,
  description: string,
  min: number,
  max: number,
  step: number,
): FieldSpec => ({ path: `layers.city.${k}`, section: 'layer:city', kind: 'number', min, max, step, integer: true, label, description });
const cityBool = (k: string, label: string, description: string): FieldSpec => ({
  path: `layers.city.${k}`,
  section: 'layer:city',
  kind: 'boolean',
  label,
  description,
});

const CITY_FIELDS: FieldSpec[] = [
  ...commonLayerFields('city', 'cities'),
  cityBool('capitalOf', '"Capital of…?" questions', 'Also ask for the capital of each country by name (capitals only).'),
  cityBool('tiers.capitals', 'Capitals', 'One capital per country.'),
  cityBool('tiers.major', 'Major cities', 'Big non-capital cities (see the thresholds below).'),
  cityBool('tiers.extended', 'Extended cities', 'Cities over 300,000 people, up to 25 per country.'),
  cityNumber('majorPopThreshold', 'Major city population', 'Non-capital cities at least this big count as major.', CITY_POP_FLOOR, 20_000_000, 100_000),
  cityNumber('majorMaxPerCountry', 'Major cities per country', 'At most this many major cities per country, biggest first.', 1, 50, 1),
  cityNumber(
    'homeCountryPopThreshold',
    'Home country city population',
    'In your home country, cities at least this big count as major.',
    CITY_POP_FLOOR,
    5_000_000,
    50_000,
  ),
  cityBool('requireCountryFirst', 'Learn the country first', "Introduce a city only once you can find its country (its Find it card has graduated)."),
  cityBool('showCountryInPrompt', 'Show country in Find prompts', 'Ask "Lyon, France" rather than just "Lyon".'),
  cityBool('showDotsDuringFind', 'Show city dots during Find', 'Show all city dots while you look for a city (click one to answer).'),
  cityBool('showCountryLabelsDuringName', 'Show country names during Name', 'Keep country labels on while naming a city.'),
  cityNumber('maxLocateKm', 'Find it: furthest accepted click (km)', 'A click further than this from the city is wrong, even with no nearer city.', 25, 2000, 25),
  cityNumber('preciseKm', 'Find it: precise within (km)', 'A correct click further than this counts as Hard at best.', 5, 500, 5),
];

/** Every editable setting, in display order. The settings panel renders from this list. */
export const FIELDS: FieldSpec[] = [...GLOBAL_FIELDS, ...SCHEDULER_FIELDS, ...COUNTRY_FIELDS, ...CITY_FIELDS];

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

const LAYER_FILTERS: LayerFilter[] = ['all', 'country', 'city'];

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
  if (path === 'global.layerFilter') {
    return LAYER_FILTERS.includes(value as LayerFilter)
      ? { ok: true, settings: setPath(settings, path, value) }
      : { ok: false, error: 'Unknown layer' };
  }
  const f = FIELDS.find((x) => x.path === path);
  if (!f) return { ok: false, error: `Unknown setting ${path}` };
  const err = checkField(f, value, countries);
  if (err) return { ok: false, error: err };
  const next = setPath(settings, path, value);
  const cross = f.validate?.(value, next);
  return cross ? { ok: false, error: cross } : { ok: true, settings: next };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Phase 2 (schema v1) settings had `learning`, `grading` and `display` at the top level. */
export function isV1Settings(raw: unknown): boolean {
  return isObj(raw) && isObj(raw.learning) && !isObj(raw.layers);
}

/** Map Phase 2 settings onto the v2 shape: country options move into layers.country. */
export function upgradeSettingsV1(raw: unknown): unknown {
  if (!isV1Settings(raw)) return raw;
  const r = raw as Obj;
  const learning = r.learning as Obj;
  const display = isObj(r.display) ? r.display : {};
  return {
    global: {
      homeCountry: learning.homeCountry,
      dayStartHour: learning.dayStartHour,
      learnAheadMinutes: learning.learnAheadMinutes,
      showTimer: display.showTimer,
    },
    fsrs: r.fsrs,
    layers: {
      country: {
        directionMode: learning.directionMode,
        scope: learning.scope,
        newPerDay: learning.newPerDay,
        maxReviewsPerDay: learning.maxReviewsPerDay,
        pauseNewIfDueAbove: learning.pauseNewIfDueAbove,
        burySiblings: learning.burySiblings,
        grading: r.grading,
      },
    },
  };
}

/**
 * Settings from storage or an import (v1 or v2): fill missing fields with
 * defaults and replace invalid ones, reporting which were replaced.
 */
export function normaliseSettings(input: unknown): { settings: Settings; replaced: string[] } {
  const raw = upgradeSettingsV1(input);
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
  const filter = getPath(raw, 'global.layerFilter');
  if (LAYER_FILTERS.includes(filter as LayerFilter)) settings.global.layerFilter = filter as LayerFilter;
  return { settings, replaced };
}
