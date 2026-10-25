import type { NameEntry } from '../../srs/answerMatch';
import type { CountryId } from '../../types';
import type { CapitalEntry, CityRecord } from './tiers';

export interface CitiesFile {
  version: number;
  /** Smallest population included (except capitals and each country's largest place). */
  popFloor: number;
  capitals: Record<CountryId, CapitalEntry>;
  cities: CityRecord[];
}

export interface CityData {
  cities: CityRecord[];
  byId: Map<string, CityRecord>;
  byCountry: Map<CountryId, CityRecord[]>;
  capitals: Record<CountryId, CapitalEntry>;
  /** Capital city ID → its country. */
  capitalOf: Map<string, CountryId>;
  /** Display name + accepted answers per city, for answer matching. */
  names: Record<string, NameEntry>;
}

export function buildCityData(file: CitiesFile): CityData {
  const byCountry = new Map<CountryId, CityRecord[]>();
  for (const c of file.cities) {
    const list = byCountry.get(c.c);
    if (list) list.push(c);
    else byCountry.set(c.c, [c]);
  }
  return {
    cities: file.cities,
    byId: new Map(file.cities.map((c) => [c.i, c])),
    byCountry,
    capitals: file.capitals,
    capitalOf: new Map(Object.entries(file.capitals).map(([country, cap]) => [cap.city, country])),
    names: Object.fromEntries(file.cities.map((c) => [c.i, { display: c.n, accepted: [c.n, ...(c.a ?? [])] }])),
  };
}

export async function loadCities(baseUrl = import.meta.env.BASE_URL): Promise<CityData> {
  const resp = await fetch(`${baseUrl}data/cities.json`);
  if (!resp.ok) throw new Error(`Failed to load cities.json: HTTP ${resp.status}`);
  return buildCityData((await resp.json()) as CitiesFile);
}
