import { beforeEach, describe, expect, it } from 'vitest';
import { CityLayer, evaluateCityClick, kmBetween } from '../src/layers/city/cityLayer';
import { computeTiers } from '../src/layers/city/tiers';
import { CountryLayer } from '../src/layers/country/countryLayer';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings/schema';
import { cardKey, type CardRecord } from '../src/srs/queue';
import { Scheduler } from '../src/srs/scheduler';
import type { LonLat } from '../src/types';
import { cityData, countryData, quizData } from './fixtures';

const data = cityData();
const countries = countryData();
const countryLayer = new CountryLayer(quizData(), countries.meta);
const layer = new CityLayer(data, countries, {
  name: (id) => countryLayer.displayName(id),
  neighbours: (id) => countries.meta.get(id)?.neighbours ?? [],
});
const city = (id: string) => data.byId.get(id)!;
const ll = (id: string): LonLat => [city(id).lon, city(id).lat];

let settings: Settings;
beforeEach(() => {
  settings = structuredClone(DEFAULT_SETTINGS);
});

describe('city data', () => {
  it('has exactly one capital per in-scope country, all real cities in that country', () => {
    const scope = quizData().scopes.sovereign;
    expect(Object.keys(data.capitals).sort()).toEqual([...scope].sort());
    for (const [country, cap] of Object.entries(data.capitals)) expect(city(cap.city).c, country).toBe(country);
    expect(new Set(data.cities.map((c) => c.i)).size).toBe(data.cities.length);
  });
});

describe('tiers', () => {
  const tiers = (over: Partial<Settings['layers']['city']> = {}, home = 'GBR') => {
    const c = { ...settings.layers.city, ...over };
    return computeTiers(data.cities, data.capitals, { ...c, home });
  };

  it('assigns capitals, capped major cities and extended cities', () => {
    const t = tiers();
    expect(t.get('gbr-london')).toBe('capital');
    expect(t.get('deu-munich')).toBe('major');
    expect([...t].filter(([id, tier]) => tier === 'major' && id.startsWith('chn-')).length).toBeLessThanOrEqual(8);
    expect([...t].filter(([, tier]) => tier === 'capital')).toHaveLength(197);
  });

  it('boosts the home country and follows the home setting', () => {
    expect(tiers({}, 'GBR').get('gbr-southampton')).toBe('major');
    expect(tiers({}, 'FRA').get('gbr-southampton')).not.toBe('major');
    expect(tiers({}, 'FRA').get('fra-nantes')).toBe('major');
  });

  it('responds to threshold settings', () => {
    expect(tiers({ majorPopThreshold: 5_000_000 }).get('deu-munich')).not.toBe('major');
    // A country's largest non-capital city is always major.
    const largestDe = data.cities.filter((c) => c.c === 'DEU' && c.i !== 'deu-berlin').sort((a, b) => b.p - a.p)[0]!;
    expect(tiers({ majorPopThreshold: 20_000_000 }).get(largestDe.i)).toBe('major');
    const capped = tiers({ majorMaxPerCountry: 1 });
    expect([...capped].filter(([id, tier]) => tier === 'major' && id.startsWith('ind-'))).toHaveLength(1);
  });

  it('active set follows enabled tiers; nothing is deleted', () => {
    settings.layers.city.tiers = { capitals: true, major: false, extended: false };
    expect(layer.activeCities(settings)).toHaveLength(197);
    settings.layers.city.tiers.extended = true;
    expect(layer.activeCities(settings).length).toBeGreaterThan(197);
  });

  it('orders capitals first, then major cities, nearest home first', () => {
    settings.layers.city.tiers.extended = true;
    const order = layer.activeCities(settings).map((c) => c.i);
    expect(order[0]).toBe('gbr-london');
    expect(order.indexOf('irl-dublin')).toBeLessThan(order.indexOf('fra-paris'));
    expect(order.indexOf('nzl-wellington')).toBeLessThan(order.indexOf('gbr-birmingham')); // all capitals before majors
    expect(order.indexOf('gbr-birmingham')).toBeLessThan(order.indexOf('fra-lyon'));
  });
});

describe('prerequisites', () => {
  const sched = new Scheduler();
  const card = (grades: ('again' | 'good' | 'easy')[]) => {
    let c = sched.newCard(new Date(2026, 0, 1));
    for (const g of grades) c = sched.review(c, c.due, g).card;
    return c;
  };
  const cards = (c: ReturnType<typeof card> | null, direction: 'locate' | 'name' = 'locate') => {
    const m = new Map<string, CardRecord>();
    if (c) m.set(cardKey('country', 'GBR', direction), { key: cardKey('country', 'GBR', direction), layerId: 'country', itemId: 'GBR', direction, card: c, introducedDay: 1 });
    return m;
  };
  const eligible = (m: Map<string, CardRecord>) => layer.queueConfig({ settings, cards: m }).eligibleNew('gbr-london');

  it("waits until the country's Find card reaches Review", () => {
    expect(eligible(cards(null))).toBe(false);
    expect(eligible(cards(card(['good'])))).toBe(false); // still learning
    expect(eligible(cards(card(['easy'])))).toBe(true);
    expect(eligible(cards(card(['easy', 'again'])))).toBe(true); // relearning: it had graduated
  });

  it('falls back to "country introduced" when country Find questions are off, and can be disabled', () => {
    settings.layers.country.directionMode = 'name';
    expect(eligible(cards(card(['good']), 'name'))).toBe(true);
    expect(eligible(cards(null))).toBe(false);
    settings.layers.country.enabled = false;
    expect(eligible(cards(card(['again']), 'name'))).toBe(true);
    settings.layers.city.requireCountryFirst = false;
    expect(eligible(cards(null))).toBe(true);
  });
});

describe('locate evaluation', () => {
  const s = { maxLocateKm: 300, preciseKm: 75 };
  const uk = data.cities.filter((c) => ['gbr-leeds', 'gbr-manchester', 'gbr-london'].includes(c.i));

  it('resolves a click between Leeds and Manchester to the nearer city', () => {
    // With the real active set too: a click 5 km east of Leeds is Leeds, not Bradford or Manchester.
    const active = layer.activeCities(settings);
    expect(evaluateCityClick(city('gbr-leeds'), [city('gbr-leeds').lon + 0.07, city('gbr-leeds').lat], active, s)).toMatchObject({ correct: true });
    const leeds = ll('gbr-leeds');
    const man = ll('gbr-manchester');
    const nearLeeds: LonLat = [leeds[0] * 0.7 + man[0] * 0.3, leeds[1] * 0.7 + man[1] * 0.3];
    expect(evaluateCityClick(city('gbr-leeds'), nearLeeds, uk, s)).toMatchObject({ correct: true });
    const r = evaluateCityClick(city('gbr-manchester'), nearLeeds, uk, s);
    expect(r).toMatchObject({ correct: false, clickedItemId: 'gbr-leeds' });
  });

  it('rejects a far click in a sparse area even with no nearer city', () => {
    const perth = city('aus-perth');
    const active = data.cities.filter((c) => c.c === 'AUS');
    const far: LonLat = [perth.lon + 10.5, perth.lat]; // ~1,000 km east, in the desert
    expect(kmBetween(far, ll('aus-perth'))).toBeGreaterThan(900);
    const r = evaluateCityClick(perth, far, active, s);
    expect(r.correct).toBe(false);
    expect(r.distanceKm).toBeGreaterThan(900);
  });

  it('caps an imprecise but correct click at Hard', () => {
    const perth = city('aus-perth');
    const active = data.cities.filter((c) => c.c === 'AUS');
    const r = evaluateCityClick(perth, [perth.lon + 1.1, perth.lat], active, s); // ~100 km
    expect(r).toMatchObject({ correct: true, gradeCap: 'hard' });
    expect(evaluateCityClick(perth, [perth.lon + 0.3, perth.lat], active, s)).toMatchObject({ correct: true, gradeCap: null });
  });

  it('snaps to a clicked dot', () => {
    expect(layer.evaluateClick('gbr-leeds', { lonLat: null, countryId: 'GBR', cityId: 'gbr-leeds' }, settings)).toMatchObject({ correct: true, distanceKm: 0 });
    expect(layer.evaluateClick('gbr-leeds', { lonLat: null, countryId: 'GBR', cityId: 'gbr-bradford' }, settings)).toMatchObject({ correct: false, clickedItemId: 'gbr-bradford' });
  });
});

describe('name evaluation', () => {
  const typed = (id: string, text: string, direction: 'name' | 'capitalOf' = 'name') => layer.evaluateTyped(id, direction, text, settings);

  it('accepts aliases and ignores accents', () => {
    expect(typed('deu-munich', 'München')).toMatchObject({ correct: true, typo: false });
    expect(typed('deu-munich', 'munchen')).toMatchObject({ correct: true, typo: false });
    expect(typed('ukr-kyiv', 'Kiev')).toMatchObject({ correct: true, typo: false });
    expect(typed('che-zurich', 'zurich')).toMatchObject({ correct: true, typo: false });
    expect(typed('ind-mumbai', 'Bombay')).toMatchObject({ correct: true });
    expect(typed('nld-the-hague', 'Den Haag')).toMatchObject({ correct: true });
    expect(typed('kaz-nur-sultan', 'Astana')).toMatchObject({ correct: true, typo: false });
    expect(typed('kaz-nur-sultan', 'Nur-Sultan')).toMatchObject({ correct: true, typo: false });
    expect(typed('gbr-sheffield', 'Sheffeld')).toMatchObject({ correct: true, typo: true });
  });

  it('rejects nearby cities and near-misses of them (same country and neighbours)', () => {
    expect(typed('gbr-leeds', 'Bradford')).toMatchObject({ correct: false, matchedItemId: 'gbr-bradford' });
    expect(typed('gbr-sheffield', 'Bradfort')).toMatchObject({ correct: false, matchedItemId: 'gbr-bradford' });
    expect(typed('nld-rotterdam', 'Antwerp')).toMatchObject({ correct: false, matchedItemId: 'bel-antwerp' });
  });

  it("doesn't penalise same-named cities elsewhere in the world", () => {
    expect(typed('ven-valencia', 'Valencia')).toMatchObject({ correct: true, typo: false });
    expect(typed('esp-valencia', 'Valencia')).toMatchObject({ correct: true, typo: false });
    expect(typed('cri-san-jose', 'San Jose')).toMatchObject({ correct: true, typo: false });
  });

  it('capitalOf accepts the capital and alsoAccept answers only', () => {
    expect(typed('bol-sucre', 'Sucre', 'capitalOf')).toMatchObject({ correct: true });
    expect(typed('bol-sucre', 'La Paz', 'capitalOf')).toMatchObject({ correct: true, typo: false });
    expect(typed('zaf-pretoria', 'Cape Town', 'capitalOf')).toMatchObject({ correct: true });
    expect(typed('zaf-pretoria', 'Bloemfontein', 'capitalOf')).toMatchObject({ correct: true });
    expect(typed('zaf-pretoria', 'Johannesburg', 'capitalOf')).toMatchObject({ correct: false, matchedItemId: 'zaf-johannesburg' });
    expect(typed('nld-amsterdam', 'The Hague', 'capitalOf')).toMatchObject({ correct: false });
    expect(typed('aus-canberra', 'Sydney', 'capitalOf')).toMatchObject({ correct: false });
    // alsoAccept is only for "Capital of": La Paz is not Sucre's name.
    expect(typed('bol-sucre', 'La Paz')).toMatchObject({ correct: false });
  });
});
