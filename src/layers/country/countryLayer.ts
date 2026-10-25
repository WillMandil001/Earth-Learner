import { DIRECTION_CHIP, type ClickInput, type Direction, type Evaluation, type LayerContext, type LearnLayer, type QuizView, type TextPart } from '../../learn/layer';
import { resolveClick, type QuizData, type ScopeId } from '../../quiz/data';
import type { Settings } from '../../settings/schema';
import { buildNameIndex, matchAnswer, type NameIndex } from '../../srs/answerMatch';
import { orderByDistance, type LayerQueueConfig } from '../../srs/queue';
import type { CountryId, CountryMeta, HighlightStyle } from '../../types';

/** Name questions never zoom past this, so small countries keep their surroundings. */
export const QUESTION_MAX_ZOOM = 8;
const QUESTION_FILL = 0.5;
const FLASHES = 3;
const FLASH_MS = 220;

/** Countries as a learn layer: find a country by clicking it, or name the highlighted one. */
export class CountryLayer implements LearnLayer {
  readonly id = 'country' as const;
  readonly name = 'Countries';
  readonly noun = 'country';
  readonly directions: readonly Direction[] = ['locate', 'name'];
  private readonly indexes = new Map<ScopeId, NameIndex>();
  private order: { key: string; items: string[] } | null = null;
  private flashTimer = 0;
  /** Bumped on every reveal/clear, so a flight that ends late can't flash a stale answer. */
  private revealSeq = 0;

  constructor(
    private readonly data: QuizData,
    private readonly meta: ReadonlyMap<CountryId, CountryMeta>,
  ) {}

  displayName(id: string): string {
    return this.data.names[id]?.display ?? this.meta.get(id)?.name ?? id;
  }

  countryOf(id: string): CountryId {
    return id;
  }

  enabled(settings: Settings): boolean {
    return settings.layers.country.enabled;
  }

  scope(settings: Settings): readonly CountryId[] {
    return this.data.scopes[settings.layers.country.scope];
  }

  /** In-scope countries, home first, then outward by border distance, ties by LABELRANK. */
  introductionOrder(settings: Settings): string[] {
    const home = settings.global.homeCountry;
    const key = `${home}|${settings.layers.country.scope}`;
    if (this.order?.key !== key) {
      const items = orderByDistance(
        this.scope(settings),
        (id) => this.data.distances.get(home, id),
        (id) => this.meta.get(id)?.labelRank ?? 99,
        home,
      );
      this.order = { key, items };
    }
    return this.order.items;
  }

  queueConfig({ settings }: LayerContext): LayerQueueConfig {
    const s = settings.layers.country;
    const dirs: Direction[] = s.directionMode === 'both' ? ['locate', 'name'] : [s.directionMode];
    return {
      layerId: this.id,
      items: this.introductionOrder(settings),
      directions: () => dirs,
      eligibleNew: () => true,
      newPerDay: s.newPerDay,
      maxReviewsPerDay: s.maxReviewsPerDay,
      pauseNewIfDueAbove: s.pauseNewIfDueAbove,
      burySiblings: s.burySiblings,
    };
  }

  grading(direction: Direction, settings: Settings) {
    const g = settings.layers.country.grading;
    return { thresholds: direction === 'locate' ? g.locate : g.name, typoTolerance: g.typoTolerance };
  }

  question(id: string, direction: Direction) {
    return direction === 'locate'
      ? { answer: 'click' as const, chip: DIRECTION_CHIP.locate, prompt: ['Find: ', { strong: this.displayName(id) }] }
      : { answer: 'type' as const, chip: DIRECTION_CHIP.name, prompt: ['Name the highlighted country'] };
  }

  evaluateClick(id: string, click: ClickInput, settings: Settings): Evaluation {
    const resolved = resolveClick(this.data, settings.layers.country.scope, click.countryId);
    const correct = resolved === id;
    const km = click.countryId && !correct ? this.data.distances.get(click.countryId, id) : NaN;
    return {
      correct,
      typo: false,
      gradeCap: null,
      clickedItemId: click.countryId,
      distanceKm: Number.isNaN(km) ? null : km,
      matchedItemId: null,
    };
  }

  evaluateTyped(id: string, _direction: Direction, text: string, settings: Settings): Evaluation {
    const s = settings.layers.country;
    const m = matchAnswer(this.index(s.scope), id, text, s.grading.typoTolerance);
    return {
      correct: m.kind === 'exact' || m.kind === 'typo',
      typo: m.kind === 'typo',
      gradeCap: null,
      clickedItemId: null,
      distanceKm: null,
      matchedItemId: m.kind === 'wrong' ? m.other : null,
    };
  }

  revealDetail(id: string, direction: Direction, r: Evaluation & { answer: string; gaveUp: boolean }): TextPart[] {
    const target = this.displayName(id);
    if (r.correct) {
      if (r.typo) return ['Spelled: ', { strong: target }];
      return direction === 'name' ? [{ strong: target }] : [];
    }
    if (direction === 'locate') {
      const clicked = r.clickedItemId ? (this.meta.get(r.clickedItemId)?.name ?? r.clickedItemId) : null;
      const where = clicked
        ? `You clicked ${clicked}${r.distanceKm === null ? '.' : r.distanceKm === 0 ? ', which borders it.' : `: you were ${r.distanceKm.toLocaleString()} km off.`}`
        : r.gaveUp
          ? ''
          : 'You clicked the sea.';
      return ['This is ', { strong: target }, '. ', where];
    }
    return ['It is ', { strong: target }, '.', r.matchedItemId ? ` "${r.answer.trim()}" is ${this.displayName(r.matchedItemId)}.` : ''];
  }

  presentQuestion(view: QuizView, id: string, direction: Direction): void {
    if (direction === 'locate') {
      // The camera stays where it is: finding the country is the question.
      view.globe.clearHighlights();
      return;
    }
    view.globe.setHighlights({ [id]: 'target' });
    this.frame(view, id);
  }

  presentReveal(view: QuizView, id: string, direction: Direction, r: Evaluation): void {
    const seq = ++this.revealSeq;
    if (r.correct) {
      view.globe.setHighlights({ [id]: 'correct' });
    } else if (direction === 'locate') {
      const marks: Record<CountryId, HighlightStyle> = { [id]: 'correct' };
      if (r.clickedItemId && r.clickedItemId !== id) marks[r.clickedItemId] = 'wrong';
      view.globe.setHighlights(marks);
      void this.frame(view, id).then(() => seq === this.revealSeq && this.flash(view, id, marks));
    } else {
      view.globe.setHighlights({ [id]: 'wrong' });
    }
  }

  clearPresentation(view: QuizView): void {
    this.revealSeq++;
    clearInterval(this.flashTimer);
    view.globe.clearHighlights();
  }

  private frame(view: QuizView, id: string): Promise<void> {
    const anchor = this.meta.get(id)?.labelPoint;
    return view.globe.flyToCountry(id, { anchor, maxZoom: QUESTION_MAX_ZOOM, fill: QUESTION_FILL });
  }

  /** Blink the correct country so the eye finds it. */
  private flash(view: QuizView, id: string, marks: Record<CountryId, HighlightStyle>): void {
    let n = 0;
    clearInterval(this.flashTimer);
    this.flashTimer = window.setInterval(() => {
      n++;
      const next = { ...marks };
      if (n % 2) delete next[id];
      view.globe.setHighlights(next);
      if (n >= FLASHES * 2) clearInterval(this.flashTimer);
    }, FLASH_MS);
  }

  private index(scope: ScopeId): NameIndex {
    let idx = this.indexes.get(scope);
    if (!idx) {
      idx = buildNameIndex(this.data.names, this.data.scopes[scope]);
      this.indexes.set(scope, idx);
    }
    return idx;
  }
}
