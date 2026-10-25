import { geoDistance } from 'd3-geo';
import { DIRECTION_CHIP, type ClickInput, type Direction, type Evaluation, type LayerContext, type LearnLayer, type QuestionSpec, type QuizView, type TextPart } from '../../learn/layer';
import type { CityCommonSettings, Settings } from '../../settings/schema';
import { buildNameIndex, matchAnswer, type NameEntry, type NameIndex } from '../../srs/answerMatch';
import { cardKey, type LayerQueueConfig } from '../../srs/queue';
import { cardState } from '../../srs/scheduler';
import type { CountryData, CountryId, LonLat } from '../../types';
import type { CityData } from './cityData';
import type { CityRenderLayer, RenderCity } from './cityRenderLayer';
import { computeTiers, type CityRecord, type CityTier } from './tiers';

const EARTH_RADIUS_KM = 6371.0088;
const TIER_ORDER: Record<CityTier, number> = { capital: 0, major: 1, extended: 2 };
/** On a wrong blank-map click, name the nearest city if it is at least this close to the click. */
const NEAR_CITY_KM = 150;

export const kmBetween = (a: LonLat, b: LonLat) => geoDistance(a, b) * EARTH_RADIUS_KM;
const lonLat = (c: CityRecord): LonLat => [c.lon, c.lat];

/** The two city learn layers: capital cities, and all other (major/extended) cities. */
export type CityKind = 'capital' | 'city';

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

const LABELS: Record<CityKind, { name: string; noun: string }> = {
  capital: { name: 'Capital cities', noun: 'capital' },
  city: { name: 'Cities', noun: 'city' },
};

/**
 * A city learn layer. One class serves both kinds:
 * - 'capital': each country's capital; Find it, Name it and (optionally) "Capital of …?";
 * - 'city': non-capital major (and optionally extended) cities; Find it and Name it.
 * Tiers and the active set are derived from settings at runtime; changing them never deletes progress.
 */
export class CityLayer implements LearnLayer {
  readonly name: string;
  readonly noun: string;
  readonly directions: readonly Direction[];
  private readonly index: NameIndex;
  private tierCache: { key: string; tiers: Map<string, CityTier> } | null = null;
  private orderCache: { key: string; active: CityRecord[] } | null = null;
  private homeDistCache: { home: CountryId; km: Map<string, number> } | null = null;
  private candidateCache = new Map<CountryId, Set<string>>();

  constructor(
    readonly id: CityKind,
    private readonly data: CityData,
    private readonly countries: CountryData,
    private readonly info: CountryInfo,
    /** Shared Explore render layer (also shows unnamed dots during Find questions). */
    readonly render: CityRenderLayer,
  ) {
    this.name = LABELS[id].name;
    this.noun = LABELS[id].noun;
    this.directions = id === 'capital' ? ['locate', 'name', 'capitalOf'] : ['locate', 'name'];
    this.index = buildNameIndex(data.names, data.cities.map((c) => c.i));
  }

  private settingsOf(settings: Settings): CityCommonSettings {
    return settings.layers[this.id];
  }

  displayName(id: string): string {
    return this.data.byId.get(id)?.n ?? id;
  }

  countryOf(id: string): CountryId | null {
    return this.data.byId.get(id)?.c ?? null;
  }

  enabled(settings: Settings): boolean {
    return this.settingsOf(settings).enabled;
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

  /** Is this city in a tier this layer learns? */
  private inLayer(tier: CityTier | undefined, settings: Settings): boolean {
    if (this.id === 'capital') return tier === 'capital';
    const t = settings.layers.city.tiers;
    return (tier === 'major' && t.major) || (tier === 'extended' && t.extended);
  }

  /**
   * This layer's cities in introduction order: (for 'city': major before
   * extended), then by distance from the home country's border, then population.
   */
  activeCities(settings: Settings): CityRecord[] {
    const t = settings.layers.city.tiers;
    const key = `${tierKey(settings)}|${t.major}|${t.extended}`;
    if (this.orderCache?.key !== key) {
      const tiers = this.tiers(settings);
      const home = settings.global.homeCountry;
      const active = this.data.cities.filter((c) => this.inLayer(tiers.get(c.i), settings));
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
   * Every city location the learner might be asked about: all capitals plus the
   * cities in the enabled city tiers. These are the dots shown in "dots" Find mode.
   */
  allCityDots(settings: Settings): CityRecord[] {
    const t = settings.layers.city.tiers;
    const tiers = this.tiers(settings);
    return this.data.cities.filter((c) => {
      const tier = tiers.get(c.i);
      return tier === 'capital' || (tier === 'major' && t.major) || (tier === 'extended' && t.extended);
    });
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
    if (!this.settingsOf(s).requireCountryFirst) return true;
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
    const s = this.settingsOf(ctx.settings);
    const base: Direction[] = s.directionMode === 'both' ? ['locate', 'name'] : [s.directionMode];
    const dirs: Direction[] = this.id === 'capital' && ctx.settings.layers.capital.capitalOf ? [...base, 'capitalOf'] : base;
    const ready = new Map<CountryId, boolean>();
    return {
      layerId: this.id,
      items: this.activeCities(ctx.settings).map((c) => c.i),
      directions: () => dirs,
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
    const g = this.settingsOf(settings).grading;
    return { thresholds: direction === 'locate' ? g.locate : g.name, typoTolerance: g.typoTolerance };
  }

  question(id: string, direction: Direction, settings: Settings): QuestionSpec {
    const s = this.settingsOf(settings);
    const city = this.data.byId.get(id)!;
    const country = this.info.name(city.c);
    if (direction === 'locate') {
      const prompt: TextPart[] = ['Find: ', { strong: city.n }];
      if (s.showCountryInPrompt) prompt.push(`, ${country}`);
      const hint =
        s.findMode === 'dots'
          ? 'Click its dot. Drag to rotate, scroll to zoom.'
          : `Click where it is (within ${s.locateRadiusKm} km). Drag to rotate, scroll to zoom.`;
      return { answer: 'click', chip: DIRECTION_CHIP.locate, prompt, hint };
    }
    if (direction === 'capitalOf') {
      const of = this.data.capitalOf.get(id) ?? city.c;
      return { answer: 'type', chip: DIRECTION_CHIP.capitalOf, prompt: ['Capital of ', { strong: this.info.name(of) }, '?'] };
    }
    return { answer: 'type', chip: DIRECTION_CHIP.name, prompt: [`Name the marked ${this.id === 'capital' ? 'capital' : 'city'}`] };
  }

  /**
   * Blank map: correct within locateRadiusKm of the city. Dots: the clicked dot
   * must be the city; a click that misses every dot is not an answer (null).
   */
  evaluateClick(id: string, click: ClickInput, settings: Settings): Evaluation | null {
    const s = this.settingsOf(settings);
    const target = this.data.byId.get(id)!;
    if (s.findMode === 'dots') {
      if (!click.cityId) return null;
      const snapped = this.data.byId.get(click.cityId);
      if (!snapped) return null;
      return {
        correct: snapped.i === id,
        typo: false,
        gradeCap: null,
        clickedItemId: snapped.i,
        distanceKm: Math.round(kmBetween(lonLat(snapped), lonLat(target))),
        matchedItemId: null,
      };
    }
    if (!click.lonLat) return { correct: false, typo: false, gradeCap: null, clickedItemId: null, distanceKm: null, matchedItemId: null };
    return evaluateCityClick(target, click.lonLat, this.allCityDots(settings), s.locateRadiusKm);
  }

  evaluateTyped(id: string, direction: Direction, text: string, settings: Settings): Evaluation {
    const tol = this.settingsOf(settings).grading.typoTolerance;
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
    if (r.correct) return [{ strong: city.n }, `${where}: your click was ${km?.toLocaleString() ?? '?'} km away.`];
    if (r.gaveUp || km === null) return ['This is ', { strong: city.n }, `${where}.`];
    const near = r.clickedItemId && r.clickedItemId !== id ? this.data.byId.get(r.clickedItemId) : null;
    return ['This is ', { strong: city.n }, `${where}. `, near ? `You clicked near ${near.n}, ` : 'You clicked ', `${km.toLocaleString()} km off.`];
  }

  presentQuestion(view: QuizView, id: string, direction: Direction, settings: Settings): void {
    const s = this.settingsOf(settings);
    const city = this.data.byId.get(id)!;
    view.globe.clearHighlights();
    if (direction === 'locate' && s.findMode === 'dots') {
      this.render.showQuizDots(this.allCityDots(settings).map((c) => c.i));
    } else {
      this.render.mode = 'hidden';
    }
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
    const clicked = r.clickedItemId ? this.data.byId.get(r.clickedItemId) : null;
    const clickPoint = r.clickLonLat ?? (clicked ? lonLat(clicked) : null);
    if (direction === 'locate' && clickPoint && !r.correct) {
      view.markers.set([
        { lonLat: target, style: 'answer' },
        { lonLat: clickPoint, style: 'click' },
      ]);
      void view.globe.flyToFit({ type: 'MultiPoint', coordinates: [target, clickPoint] }, { fill: 0.6, minZoom: 1.5, maxZoom: 7 });
      return;
    }
    view.markers.set([
      { lonLat: target, style: 'answer' },
      ...(direction === 'locate' && clickPoint ? [{ lonLat: clickPoint, style: 'click' as const }] : []),
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

/**
 * Blank-map locate check (exported for tests): correct within `radiusKm` of the
 * city. For a wrong click, the nearest city (if close to the click) is named.
 */
export function evaluateCityClick(target: CityRecord, click: LonLat, cities: readonly CityRecord[], radiusKm: number): Evaluation {
  const km = kmBetween(click, lonLat(target));
  const correct = km <= radiusKm;
  let nearest: CityRecord | null = null;
  let nearestKm = Infinity;
  if (!correct) {
    for (const c of cities) {
      const d = kmBetween(click, lonLat(c));
      if (d < nearestKm) {
        nearestKm = d;
        nearest = c;
      }
    }
  }
  return {
    correct,
    typo: false,
    gradeCap: null,
    clickedItemId: nearest && nearestKm <= NEAR_CITY_KM ? nearest.i : null,
    distanceKm: Math.round(km),
    matchedItemId: null,
  };
}

/** Earlier Phase 3 builds kept capitals in the 'city' layer: rekey those cards to 'capital'. */
export function capitalCardRekey(data: CityData) {
  return <T extends { layerId: string; itemId: string; direction: string }>(rec: T): T | null =>
    rec.layerId === 'city' && data.capitalOf.has(rec.itemId)
      ? { ...rec, layerId: 'capital', key: cardKey('capital', rec.itemId, rec.direction as Direction) }
      : null;
}
