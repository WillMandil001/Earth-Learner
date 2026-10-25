/**
 * City tiers, computed at runtime from settings (and the home country), so
 * changing thresholds never needs a data rebuild. Pure and dependency-free:
 * scripts/build-data.mjs imports this file directly for its validation stats.
 */

/** One city in public/data/cities.json (short keys keep the file small). */
export interface CityRecord {
  /** Stable ID, e.g. "gbr-london". */
  i: string;
  /** Display name. */
  n: string;
  /** Country (ADM0_A3, in quiz scope). */
  c: string;
  lon: number;
  lat: number;
  /** Population (NE POP_MAX). */
  p: number;
  /** NE SCALERANK: lower = more important (label priority). */
  r: number;
  /** Extra accepted names (native names, exonyms, old names). */
  a?: string[];
}

export interface CapitalEntry {
  city: string;
  /** Extra answers accepted for "Capital of" questions (e.g. Bolivia: La Paz). */
  alsoAccept: string[];
}

export type CityTier = 'capital' | 'major' | 'extended';

export interface TierOptions {
  majorPopThreshold: number;
  majorMaxPerCountry: number;
  homeCountryPopThreshold: number;
  home: string;
}

export const EXTENDED_POP_THRESHOLD = 300_000;
export const EXTENDED_MAX_PER_COUNTRY = 25;

/**
 * Tier of every city that qualifies for one (regardless of which tiers are enabled):
 * - capital: the country's capital from capitals.json;
 * - major: non-capitals with population ≥ majorPopThreshold, biggest first, at most
 *   majorMaxPerCountry, plus the country's largest city even if smaller. In the home
 *   country the threshold is homeCountryPopThreshold and the cap is at least 25;
 * - extended: remaining cities ≥ 300,000, at most 25 per country.
 */
export function computeTiers(
  cities: readonly CityRecord[],
  capitals: Readonly<Record<string, CapitalEntry>>,
  opts: TierOptions,
): Map<string, CityTier> {
  const tiers = new Map<string, CityTier>();
  const byCountry = new Map<string, CityRecord[]>();
  for (const c of cities) {
    const list = byCountry.get(c.c);
    if (list) list.push(c);
    else byCountry.set(c.c, [c]);
  }
  for (const [country, list] of byCountry) {
    const capital = capitals[country]?.city;
    if (capital) tiers.set(capital, 'capital');
    const others = list.filter((c) => c.i !== capital).sort((a, b) => b.p - a.p || a.i.localeCompare(b.i));
    const home = country === opts.home;
    const threshold = home ? Math.min(opts.homeCountryPopThreshold, opts.majorPopThreshold) : opts.majorPopThreshold;
    const cap = home ? Math.max(opts.majorMaxPerCountry, EXTENDED_MAX_PER_COUNTRY) : opts.majorMaxPerCountry;
    const major = others.filter((c) => c.p >= threshold).slice(0, cap);
    if (others[0] && !major.includes(others[0])) major.push(others[0]);
    for (const c of major) tiers.set(c.i, 'major');
    const extended = others.filter((c) => !tiers.has(c.i) && c.p >= EXTENDED_POP_THRESHOLD).slice(0, EXTENDED_MAX_PER_COUNTRY);
    for (const c of extended) tiers.set(c.i, 'extended');
  }
  return tiers;
}
