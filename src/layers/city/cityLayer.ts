import { geoDistance } from 'd3-geo';
import { DIRECTION_CHIP, type ClickInput, type Direction, type Evaluation, type LayerContext, type LearnLayer, type QuestionSpec, type QuizView, type TextPart } from '../../learn/layer';
import type { CityLayerSettings, Settings } from '../../settings/schema';
import { buildNameIndex, matchAnswer, type NameEntry, type NameIndex } from '../../srs/answerMatch';
import { cardKey, type LayerQueueConfig } from '../../srs/queue';
import { cardState } from '../../srs/scheduler';
import type { CountryData, CountryId, LonLat } from '../../types';
import type { CityData } from './cityData';
import { CityRenderLayer, type RenderCity } from './cityRenderLayer';
import { computeTiers, type CityRecord, type CityTier } from './tiers';

const EARTH_RADIUS_KM = 6371.0088;
const TIER_ORDER: Record<CityTier, number> = { capital: 0, major: 1, extended: 2 };

export const kmBetween = (a: LonLat, b: LonLat) => geoDistance(a, b) * EARTH_RADIUS_KM;
const lonLat = (c: CityRecord): LonLat => [c.lon, c.lat];

/** Country display names (from the country layer) and land neighbours. */
export interface CountryInfo {
  name(id: CountryId): string;
  neighbours(id: CountryId): readonly CountryId[];
}

/** Settings that decide tier membership; used as a cache key. */
const tierKey = (s: Settings) => {
  const c = s.layers.city;
  return `${s.global.homeCountry}|${c.majorPopThreshold}|${c.majorMaxPerCountry}|${c.homeCountryPopThreshold}`;
};

/**
 * Cities as a learn layer: find a city by clicking near it, name a marked
 * city, and (optionally) "Capital of …?". Tiers and the active set are derived
 * from settings at runtime; changing them never deletes progress.
 */
export class CityLayer implements LearnLayer {
  readonly id = 'city' as const;
  readonly name = 'Cities';
  readonly noun = 'city';
  readonly directions: readonly Direction[] = ['locate', 'name', 'capitalOf'];
  readonly render = new CityRenderLayer();
  private readonly index: NameIndex;
  private tierCache: { key: string; tiers: Map<string, CityTier> } | null = null;
  private orderCache: { key: string; active: CityRecord[] } | null = null;
  private homeDistCache: { home: CountryId; km: Map<string, number> } | null = null;
  private candidateCache = new Map<CountryId, Set<string>>();

  constructor(
    private readonly data: CityData,
    private readonly countries: CountryData,
    private readonly info: CountryInfo,
  ) {
    this.index = buildNameIndex(data.names, data.cities.map((c) => c.i));
  }

  displayName(id: string): string {
    return this.data.byId.get(id)?.n ?? id;
  }

  countryOf(id: string): CountryId | null {
    return this.data.byId.get(id)?.c ?? null;
  }

  enabled(settings: Settings): boolean {
    return settings.layers.city.enabled;
  }

  city(id: string): CityRecord | undefined {
    return this.data.byId.get(id);
  }

  /** Tier of every city (capital / major / extended) under the current settings and home. */
  tiers(settings: Settings): Map<string, CityTier> {
    const key = tierKey(settings);
    if (this.tierCache?.key !== key) {
      const c = settings.layers.city;
      const tiers = computeTiers(this.data.cities, this.data.capitals, {
        majorPopThreshold: c.majorPopThreshold,
        majorMaxPerCountry: c.majorMaxPerCountry,
        homeCountryPopThreshold: c.homeCountryPopThreshold,
        home: settings.global.homeCountry,
      });
      this.tierCache = { key, tiers };
    }
    return this.tierCache.tiers;
  }

  /**
   * Cities in enabled tiers, in introduction order: capitals, then major, then
   * extended; within a tier by distance from the home country's border, then population.
   */
  activeCities(settings: Settings): CityRecord[] {
    const t = settings.layers.city.tiers;
    const key = `${tierKey(settings)}|${t.capitals}|${t.major}|${t.extended}`;
    if (this.orderCache?.key !== key) {
      const tiers = this.tiers(settings);
      const on: Record<CityTier, boolean> = { capital: t.capitals, major: t.major, extended: t.extended };
      const home = settings.global.homeCountry;
      const active = this.data.cities.filter((c) => {
        const tier = tiers.get(c.i);
        return tier !== undefined && on[tier];
      });
      active.sort(
        (a, b) =>
          TIER_ORDER[tiers.get(a.i)!] - TIER_ORDER[tiers.get(b.i)!] ||
          this.kmFromHome(a, home) - this.kmFromHome(b, home) ||
          b.p - a.p ||
          a.i.localeCompare(b.i),
      );
      this.orderCache = { key, active };
    }
    return this.orderCache.active;
  }

  /**
   * Distance from a city to the home country's border (0 inside it), from the
   * 110m outline's vertices: ~2k cities × a few hundred vertices, a few ms.
   */
  kmFromHome(city: CityRecord, home: CountryId): number {
    if (this.homeDistCache?.home !== home) this.homeDistCache = { home, km: new Map() };
    const cache = this.homeDistCache.km;
    let km = cache.get(city.i);
    if (km === undefined) {
      km = city.c === home ? 0 : this.kmToCountry(lonLat(city), home);
      cache.set(city.i, km);
    }
    return km;
  }

  private kmToCountry(p: LonLat, country: CountryId): number {
    const parts = this.countries.lods.low.parts.get(country);
    if (!parts) return Infinity;
    const l = (p[0] * Math.PI) / 180;
    const f = (p[1] * Math.PI) / 180;
    const x = Math.cos(f) * Math.cos(l);
    const y = Math.cos(f) * Math.sin(l);
    const z = Math.sin(f);
    let best = -1;
    for (const part of parts) {
      const v = part.packed.xyz;
      for (let i = 0; i < v.length; i += 3) best = Math.max(best, x * v[i]! + y * v[i + 1]! + z * v[i + 2]!);
    }
    return Math.acos(Math.min(1, best)) * EARTH_RADIUS_KM;
  }

  /** Cities to draw in Explore: every tiered city, so all tiers are visible regardless of learn settings. */
  renderCities(settings: Settings): RenderCity[] {
    const home = settings.global.homeCountry;
    return [...this.tiers(settings)].map(([id, tier]) => {
      const rec = this.data.byId.get(id)!;
      return { rec, tier, home: rec.c === home };
    });
  }

  /** Is the city's country learned well enough to introduce the city? */
  countryReady(country: CountryId, ctx: LayerContext): boolean {
    const s = ctx.settings;
    if (!s.layers.city.requireCountryFirst) return true;
    const locateActive = s.layers.country.enabled && s.layers.country.directionMode !== 'name';
    if (locateActive) {
      const rec = ctx.cards.get(cardKey('country', country, 'locate'));
      if (!rec) return false;
      const state = cardState(rec.card);
      return state === 'review' || state === 'relearning';
    }
    // Fallback: the country layer is off or not asking Find questions; "introduced" is enough.
    return (['locate', 'name'] as const).some((d) => ctx.cards.has(cardKey('country', country, d)));
  }

  queueConfig(ctx: LayerContext): LayerQueueConfig {
    const s = ctx.settings.layers.city;
    const tiers = this.tiers(ctx.settings);
    const base: Direction[] = s.directionMode === 'both' ? ['locate', 'name'] : [s.directionMode];
    const withCapital: Direction[] = s.capitalOf ? [...base, 'capitalOf'] : base;
    const ready = new Map<CountryId, boolean>();
    return {
      layerId: this.id,
      items: this.activeCities(ctx.settings).map((c) => c.i),
      directions: (id) => (tiers.get(id) === 'capital' ? withCapital : base),
      eligibleNew: (id) => {
        const country = this.data.byId.get(id)?.c;
        if (!country) return false;
        if (!ready.has(country)) ready.set(country, this.countryReady(country, ctx));
        return ready.get(country)!;
      },
      newPerDay: s.newPerDay,
      maxReviewsPerDay: s.maxReviewsPerDay,
      pauseNewIfDueAbove: s.pauseNewIfDueAbove,
      burySiblings: s.burySiblings,
    };
  }

  grading(direction: Direction, settings: Settings) {
    const g = settings.layers.city.grading;
    return { thresholds: direction === 'locate' ? g.locate : g.name, typoTolerance: g.typoTolerance };
  }

  question(id: string, direction: Direction, settings: Settings): QuestionSpec {
    const city = this.data.byId.get(id)!;
    const country = this.info.name(city.c);
    if (direction === 'locate') {
      const prompt: TextPart[] = ['Find: ', { strong: city.n }];
      if (settings.layers.city.showCountryInPrompt) prompt.push(`, ${country}`);
      return { answer: 'click', chip: DIRECTION_CHIP.locate, prompt };
    }
    if (direction === 'capitalOf') {
      const of = this.data.capitalOf.get(id) ?? city.c;
      return { answer: 'type', chip: DIRECTION_CHIP.capitalOf, prompt: ['Capital of ', { strong: this.info.name(of) }, '?'] };
    }
    return { answer: 'type', chip: DIRECTION_CHIP.name, prompt: ['Name the marked city'] };
  }

  /**
   * A click is correct if the nearest city in the active set is the target and
   * it is within maxLocateKm. Beyond preciseKm the grade is capped at Hard.
   * Clicking a visible dot snaps to that city.
   */
  evaluateClick(id: string, click: ClickInput, settings: Settings): Evaluation {
    const s = settings.layers.city;
    const target = this.data.byId.get(id)!;
    const wrong: Evaluation = { correct: false, typo: false, gradeCap: null, clickedItemId: null, distanceKm: null, matchedItemId: null };
    if (click.cityId) {
      const snapped = this.data.byId.get(click.cityId);
      if (!snapped) return wrong;
      const km = kmBetween(lonLat(snapped), lonLat(target));
      return { ...wrong, correct: snapped.i === id, clickedItemId: snapped.i, distanceKm: Math.round(km) };
    }
    if (!click.lonLat) return wrong;
    return evaluateCityClick(target, click.lonLat, this.activeCities(settings), s);
  }

  evaluateTyped(id: string, direction: Direction, text: string, settings: Settings): Evaluation {
    const tol = settings.layers.city.grading.typoTolerance;
    const city = this.data.byId.get(id)!;
    const m =
      direction === 'capitalOf'
        ? matchAnswer(this.capitalIndex(id), id, text, tol)
        : matchAnswer(this.index, id, text, tol, this.candidates(city.c));
    return {
      correct: m.kind === 'exact' || m.kind === 'typo',
      typo: m.kind === 'typo',
      gradeCap: null,
      clickedItemId: null,
      distanceKm: null,
      matchedItemId: m.kind === 'wrong' ? m.other : null,
    };
  }

  /**
   * Cities that count for the ambiguity guard when naming a city: those in the
   * same country and its land neighbours (same names elsewhere don't matter,
   * because the marker identifies the city).
   */
  candidates(country: CountryId): Set<string> {
    let set = this.candidateCache.get(country);
    if (!set) {
      set = new Set();
      for (const c of [country, ...this.info.neighbours(country)]) for (const city of this.data.byCountry.get(c) ?? []) set.add(city.i);
      this.candidateCache.set(country, set);
    }
    return set;
  }

  /** "Capital of" answers: the capital's names plus alsoAccept, guarded against the country's other cities. */
  private capitalIndex(capitalId: string): NameIndex {
    const country = this.data.capitalOf.get(capitalId) ?? this.data.byId.get(capitalId)!.c;
    const names: Record<string, NameEntry> = {};
    for (const c of this.data.byCountry.get(country) ?? []) names[c.i] = this.data.names[c.i]!;
    const own = this.data.names[capitalId]!;
    names[capitalId] = { display: own.display, accepted: [...own.accepted, ...(this.data.capitals[country]?.alsoAccept ?? [])] };
    return buildNameIndex(names, Object.keys(names));
  }

  revealDetail(id: string, direction: Direction, r: Evaluation & { answer: string; gaveUp: boolean }): TextPart[] {
    const city = this.data.byId.get(id)!;
    const where = `, ${this.info.name(city.c)}`;
    if (direction === 'capitalOf') {
      const country = this.data.capitalOf.get(id) ?? city.c;
      const also = this.data.capitals[country]?.alsoAccept ?? [];
      return [
        `The capital of ${this.info.name(country)} is `,
        { strong: city.n },
        '.',
        also.length ? ` (${also.join(', ')} also accepted.)` : '',
        r.typo ? ' Mind the spelling.' : '',
      ];
    }
    if (direction === 'name') {
      if (r.correct) return r.typo ? ['Spelled: ', { strong: city.n }, where] : [{ strong: city.n }, where];
      const other = r.matchedItemId ? this.data.byId.get(r.matchedItemId) : null;
      return ['It is ', { strong: city.n }, `${where}.`, other ? ` "${r.answer.trim()}" is ${other.n}, ${this.info.name(other.c)}.` : ''];
    }
    const km = r.distanceKm;
    if (r.correct) {
      return [
        { strong: city.n },
        `${where}: your click was ${km?.toLocaleString() ?? '?'} km away.`,
        r.gradeCap === 'hard' ? ' Not precise enough for better than Hard.' : '',
      ];
    }
    if (r.gaveUp || km === null) return ['This is ', { strong: city.n }, `${where}.`];
    const near = r.clickedItemId && r.clickedItemId !== id ? this.data.byId.get(r.clickedItemId) : null;
    return ['This is ', { strong: city.n }, `${where}. `, near ? `You clicked near ${near.n}, ` : 'You clicked ', `${km.toLocaleString()} km off.`];
  }

  presentQuestion(view: QuizView, id: string, direction: Direction, settings: Settings): void {
    const s = settings.layers.city;
    const city = this.data.byId.get(id)!;
    view.globe.clearHighlights();
    this.render.mode = direction === 'locate' && s.showDotsDuringFind ? 'dots' : 'hidden';
    view.globe.redraw();
    if (direction === 'name') {
      if (s.showCountryLabelsDuringName) view.globe.setLabelMode('all');
      view.markers.set([{ lonLat: lonLat(city), style: 'pulse' }]);
      // Show the city in its region: roughly the country and its neighbours, not street level.
      void view.globe.flyToCountry(city.c, { anchor: lonLat(city), fill: 0.65, minZoom: 3, maxZoom: 6 });
    }
    // Locate: the camera stays put. Capital of: no globe interaction at all.
  }

  presentReveal(view: QuizView, id: string, direction: Direction, r: Evaluation & { clickLonLat: LonLat | null }): void {
    const city = this.data.byId.get(id)!;
    const target = lonLat(city);
    if (direction === 'locate' && r.clickLonLat && !r.correct) {
      view.markers.set([
        { lonLat: target, style: 'answer' },
        { lonLat: r.clickLonLat, style: 'click' },
      ]);
      void view.globe.flyToFit({ type: 'MultiPoint', coordinates: [target, r.clickLonLat] }, { fill: 0.6, minZoom: 1.5, maxZoom: 7 });
      return;
    }
    view.markers.set([
      { lonLat: target, style: 'answer' },
      ...(direction === 'locate' && r.clickLonLat ? [{ lonLat: r.clickLonLat, style: 'click' as const }] : []),
    ]);
    if (direction !== 'name') void view.globe.flyTo({ lon: city.lon, lat: city.lat, zoom: Math.max(view.globe.getCamera().zoom, 4) });
  }

  clearPresentation(view: QuizView): void {
    if (this.render.mode !== 'explore') {
      this.render.mode = 'explore';
      view.globe.redraw();
    }
  }
}

/** Pure locate check (exported for tests): nearest active city must be the target, within limits. */
export function evaluateCityClick(
  target: CityRecord,
  click: LonLat,
  active: readonly CityRecord[],
  s: Pick<CityLayerSettings, 'maxLocateKm' | 'preciseKm'>,
): Evaluation {
  let nearest: CityRecord | null = null;
  let nearestKm = Infinity;
  for (const c of active) {
    const km = kmBetween(click, lonLat(c));
    if (km < nearestKm) {
      nearestKm = km;
      nearest = c;
    }
  }
  const km = kmBetween(click, lonLat(target));
  const correct = nearest?.i === target.i && km <= s.maxLocateKm;
  return {
    correct,
    typo: false,
    gradeCap: correct && km > s.preciseKm ? 'hard' : null,
    // Name the nearest city only if the click was plausibly aimed at it.
    clickedItemId: nearest && nearestKm <= s.maxLocateKm ? nearest.i : null,
    distanceKm: Math.round(km),
    matchedItemId: null,
  };
}
