import type { Globe } from '../globe/Globe';
import type { MapMarkers } from '../ui/mapMarkers';
import type { Settings, TimeThresholds, TypoTolerance } from '../settings/schema';
import type { CardRecord, LayerQueueConfig } from '../srs/queue';
import type { CountryId, LonLat } from '../types';

export type LayerId = 'country' | 'capital' | 'city';
/** Question type. Every layer supports 'locate' and 'name'; layers may add more (cities: 'capitalOf'). */
export type Direction = 'locate' | 'name' | 'capitalOf';

/** Rich text for prompts and reveals: plain strings and emphasised parts. */
export type TextPart = string | { strong: string };

/** What the user did on the globe in answer to a locate question. */
export interface ClickInput {
  /** Geographic point clicked, or null for space. */
  lonLat: LonLat | null;
  /** Country polygon/marker under the pointer. */
  countryId: CountryId | null;
  /** City dot under the pointer, if dots are visible. */
  cityId: string | null;
}

export interface Evaluation {
  correct: boolean;
  /** Accepted with a spelling slip. */
  typo: boolean;
  /** Best grade allowed (e.g. Hard for an imprecise or misspelled answer). */
  gradeCap: 'hard' | null;
  /** Locate: the item the click resolved to (or the raw feature clicked), for the reveal. */
  clickedItemId: string | null;
  /** Locate: km between what was clicked and the target (null if unknown). */
  distanceKm: number | null;
  /** Typed: the other item the answer matched, if wrong. */
  matchedItemId: string | null;
}

/** Everything a layer may use to build its queue config and evaluate answers. */
export interface LayerContext {
  settings: Settings;
  cards: ReadonlyMap<string, CardRecord>;
}

/** Globe-side tools a layer uses to present questions and reveals. */
export interface QuizView {
  globe: Globe;
  markers: MapMarkers;
}

export interface QuestionSpec {
  /** 'click' = answer on the globe, 'type' = text input. */
  answer: 'click' | 'type';
  prompt: TextPart[];
  /** Short label for the direction chip, e.g. "Find it". */
  chip: string;
  /** Instruction under the prompt (defaults to a generic one). */
  hint?: string;
}

/**
 * A kind of feature that can be learned (countries, cities, later rivers…).
 * The queue, scheduler, controller and storage are layer-agnostic; everything
 * specific to a feature type lives behind this interface.
 */
export interface LearnLayer {
  readonly id: LayerId;
  /** Plural display name, e.g. "Countries". */
  readonly name: string;
  /** Singular noun for prompts, e.g. "country" ("New country"). */
  readonly noun: string;
  /** Every direction this layer can produce (for settings and sibling burying). */
  readonly directions: readonly Direction[];

  /** Display name of an item ("Czechia", "Lyon"). */
  displayName(itemId: string): string;
  /** Country an item belongs to (itself for countries), for prompts and ordering. */
  countryOf(itemId: string): CountryId | null;
  /** Is this layer turned on in settings? */
  enabled(settings: Settings): boolean;
  /**
   * Items to schedule, in introduction priority order, with their active
   * directions and the prerequisite check for introducing new ones.
   */
  queueConfig(ctx: LayerContext): LayerQueueConfig;
  /** Time thresholds and typo tolerance for a direction. */
  grading(direction: Direction, settings: Settings): { thresholds: TimeThresholds; typoTolerance: TypoTolerance };

  question(itemId: string, direction: Direction, settings: Settings): QuestionSpec;
  /** Null = the click is not an answer (e.g. it missed every dot); the question stays open. */
  evaluateClick(itemId: string, click: ClickInput, settings: Settings): Evaluation | null;
  evaluateTyped(itemId: string, direction: Direction, text: string, settings: Settings): Evaluation;
  /** Explanation shown on the reveal screen (the verdict itself is generic). */
  revealDetail(itemId: string, direction: Direction, result: Evaluation & { answer: string; gaveUp: boolean }): TextPart[];

  /** Set up the globe for a question (camera, highlights, which dots/labels show). */
  presentQuestion(view: QuizView, itemId: string, direction: Direction, settings: Settings): void;
  /** Show the answer on the globe. */
  presentReveal(view: QuizView, itemId: string, direction: Direction, result: Evaluation & { clickLonLat: LonLat | null }, settings: Settings): void;
  /** Undo anything presentQuestion/presentReveal changed (session over). */
  clearPresentation(view: QuizView): void;
}

export const DIRECTION_CHIP: Record<Direction, string> = { locate: 'Find it', name: 'Name it', capitalOf: 'Capital' };
