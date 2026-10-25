import { beforeEach, describe, expect, it } from 'vitest';
import { CityLayer, capitalCardRekey, evaluateCityClick, kmBetween } from '../src/layers/city/cityLayer';
import { CityRenderLayer } from '../src/layers/city/cityRenderLayer';
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
const info = { name: (id: string) => countryLayer.displayName(id), neighbours: (id: string) => countries.meta.get(id)?.neighbours ?? [] };
const render = new CityRenderLayer();
const capitals = new CityLayer('capital', data, countries, info, render);
const cities = new CityLayer('city', data, countries, info, render);
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
});

describe('capital and city layers', () => {
  it('splits capitals from other cities', () => {
    const caps = capitals.activeCities(settings);
    const rest = cities.activeCities(settings);
    expect(caps).toHaveLength(197);
    expect(rest.some((c) => data.capitalOf.has(c.i))).toBe(false);
    expect(rest.map((c) => c.i)).toContain('gbr-birmingham');
    settings.layers.city.tiers.extended = true;
    expect(cities.activeCities(settings).length).toBeGreaterThan(rest.length);
    expect(capitals.activeCities(settings)).toHaveLength(197);
  });

  it('orders each layer outward from home', () => {
    const caps = capitals.activeCities(settings).map((c) => c.i);
    expect(caps[0]).toBe('gbr-london');
    expect(caps.indexOf('irl-dublin')).toBeLessThan(caps.indexOf('fra-paris'));
    const rest = cities.activeCities(settings).map((c) => c.i);
    expect(rest[0]!.startsWith('gbr-')).toBe(true);
    expect(rest.indexOf('gbr-birmingham')).toBeLessThan(rest.indexOf('fra-lyon'));
  });

  it('only capitals get "Capital of" questions, when enabled', () => {
    const dirs = (layer: CityLayer, id: string) => layer.queueConfig({ settings, cards: new Map() }).directions(id);
    expect(dirs(capitals, 'gbr-london')).toEqual(['locate', 'name']);
    settings.layers.capital.capitalOf = true;
    expect(dirs(capitals, 'gbr-london')).toEqual(['locate', 'name', 'capitalOf']);
    expect(dirs(cities, 'gbr-birmingham')).toEqual(['locate', 'name']);
  });

  it('moves old capital cards from the city layer to the capital layer', () => {
    const rekey = capitalCardRekey(data);
    const rec = { key: 'city:gbr-london:capitalOf', layerId: 'city', itemId: 'gbr-london', direction: 'capitalOf' };
    expect(rekey(rec)).toEqual({ ...rec, layerId: 'capital', key: 'capital:gbr-london:capitalOf' });
    expect(rekey({ ...rec, itemId: 'gbr-leeds', key: 'city:gbr-leeds:locate', direction: 'locate' })).toBeNull();
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
  const eligible = (m: Map<string, CardRecord>, layer = capitals, id = 'gbr-london') => layer.queueConfig({ settings, cards: m }).eligibleNew(id);

  it("waits until the country's Find card reaches Review", () => {
    expect(eligible(cards(null))).toBe(false);
    expect(eligible(cards(card(['good'])))).toBe(false); // still learning
    expect(eligible(cards(card(['easy'])))).toBe(true);
    expect(eligible(cards(card(['easy', 'again'])))).toBe(true); // relearning: it had graduated
    expect(eligible(cards(card(['easy'])), cities, 'gbr-leeds')).toBe(true);
    expect(eligible(cards(null), cities, 'gbr-leeds')).toBe(false);
  });

  it('falls back to "country introduced" when country Find questions are off, and can be disabled', () => {
    settings.layers.country.directionMode = 'name';
    expect(eligible(cards(card(['good']), 'name'))).toBe(true);
    expect(eligible(cards(null))).toBe(false);
    settings.layers.country.enabled = false;
    expect(eligible(cards(card(['again']), 'name'))).toBe(true);
    settings.layers.capital.requireCountryFirst = false;
    expect(eligible(cards(null))).toBe(true);
    expect(eligible(cards(null), cities, 'gbr-leeds')).toBe(false); // each layer has its own switch
  });
});

describe('locate: blank map', () => {
  const all = () => capitals.allCityDots(settings);
  const toward = (from: LonLat, to: LonLat, f: number): LonLat => [from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f];

  it('is correct within the radius (50 km by default) and wrong beyond it', () => {
    const london = ll('gbr-london');
    const r = settings.layers.city.locateRadiusKm;
    expect(r).toBe(50);
    expect(evaluateCityClick(city('gbr-london'), [london[0] + 0.5, london[1]], all(), r)).toMatchObject({ correct: true }); // ~35 km
    const far = evaluateCityClick(city('gbr-london'), [london[0] + 1.0, london[1]], all(), r); // ~70 km
    expect(far.correct).toBe(false);
    expect(far.distanceKm).toBeGreaterThan(50);
  });

  it('names the nearest city on a wrong click', () => {
    const r = evaluateCityClick(city('gbr-london'), toward(ll('gbr-manchester'), ll('gbr-london'), 0.05), all(), 50);
    expect(r).toMatchObject({ correct: false, clickedItemId: 'gbr-manchester' });
  });

  it('a click between Leeds and Manchester counts for whichever is within range', () => {
    const p = toward(ll('gbr-leeds'), ll('gbr-manchester'), 0.15);
    expect(evaluateCityClick(city('gbr-leeds'), p, all(), 50).correct).toBe(true);
    expect(evaluateCityClick(city('gbr-manchester'), p, all(), 25).correct).toBe(false);
  });

  it('rejects a far click in a sparse area', () => {
    const perth = city('aus-perth');
    const far: LonLat = [perth.lon + 10.5, perth.lat];
    expect(kmBetween(far, ll('aus-perth'))).toBeGreaterThan(900);
    expect(evaluateCityClick(perth, far, all(), 50)).toMatchObject({ correct: false, clickedItemId: null });
  });

  it('the radius is a setting', () => {
    settings.layers.city.locateRadiusKm = 100;
    const london = ll('gbr-london');
    expect(cities.evaluateClick('gbr-birmingham', { lonLat: [ll('gbr-birmingham')[0] + 1.0, ll('gbr-birmingham')[1]], countryId: 'GBR', cityId: null }, settings)).toMatchObject({ correct: true });
    expect(capitals.evaluateClick('gbr-london', { lonLat: [london[0] + 1.0, london[1]], countryId: 'GBR', cityId: null }, settings)).toMatchObject({ correct: false });
  });
});

describe('locate: dots', () => {
  beforeEach(() => {
    settings.layers.capital.findMode = 'dots';
    settings.layers.city.findMode = 'dots';
  });

  it('the clicked dot must be the city', () => {
    expect(cities.evaluateClick('gbr-leeds', { lonLat: null, countryId: 'GBR', cityId: 'gbr-leeds' }, settings)).toMatchObject({ correct: true, distanceKm: 0 });
    expect(cities.evaluateClick('gbr-leeds', { lonLat: null, countryId: 'GBR', cityId: 'gbr-bradford' }, settings)).toMatchObject({ correct: false, clickedItemId: 'gbr-bradford' });
  });

  it('a click that misses every dot is not an answer', () => {
    expect(cities.evaluateClick('gbr-leeds', { lonLat: ll('gbr-leeds'), countryId: 'GBR', cityId: null }, settings)).toBeNull();
  });

  it('shows every city location (capitals and cities) as dots', () => {
    const dots = capitals.allCityDots(settings).map((c) => c.i);
    expect(dots).toContain('gbr-london');
    expect(dots).toContain('gbr-leeds');
    expect(dots.length).toBe(capitals.activeCities(settings).length + cities.activeCities(settings).length);
  });
});

describe('name evaluation', () => {
  const typed = (id: string, text: string, direction: 'name' | 'capitalOf' = 'name') =>
    (data.capitalOf.has(id) ? capitals : cities).evaluateTyped(id, direction, text, settings);

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
