import type { CountryId } from '../types';

/** A named set of quiz items. Add 'sovereign+dependencies' here (and in build-data.mjs) later. */
export type ScopeId = 'sovereign';
export const SCOPES: readonly ScopeId[] = ['sovereign'];

export interface CountryNames {
  /** Name used in questions. */
  display: string;
  /** Every accepted answer, raw (normalised at match time). */
  accepted: string[];
}

export interface QuizDataFile {
  version: number;
  scopes: Record<ScopeId, CountryId[]>;
  /** Non-item feature → parent item, for scoring clicks (e.g. SOL → SOM). */
  merges: Record<CountryId, CountryId>;
  names: Record<CountryId, CountryNames>;
}

export interface DistanceFile {
  ids: CountryId[];
  /** Upper triangle of the symmetric matrix, row-major, rounded km. */
  km: number[];
}

/** Border-to-border distances in km; 0 for neighbours and for a country with itself. */
export class DistanceMatrix {
  private readonly index: Map<CountryId, number>;

  constructor(private readonly file: DistanceFile) {
    this.index = new Map(file.ids.map((id, i) => [id, i]));
  }

  has(id: CountryId): boolean {
    return this.index.has(id);
  }

  get(a: CountryId, b: CountryId): number {
    let i = this.index.get(a);
    let j = this.index.get(b);
    if (i === undefined || j === undefined) return NaN;
    if (i === j) return 0;
    if (i > j) [i, j] = [j, i];
    const n = this.file.ids.length;
    return this.file.km[i * n - (i * (i + 1)) / 2 + (j - i - 1)]!;
  }
}

export interface QuizData extends QuizDataFile {
  distances: DistanceMatrix;
}

export function buildQuizData(file: QuizDataFile, distances: DistanceFile): QuizData {
  return { ...file, distances: new DistanceMatrix(distances) };
}

export async function loadQuizData(baseUrl = import.meta.env.BASE_URL): Promise<QuizData> {
  const get = async <T>(name: string): Promise<T> => {
    const resp = await fetch(`${baseUrl}data/${name}`);
    if (!resp.ok) throw new Error(`Failed to load ${name}: HTTP ${resp.status}`);
    return (await resp.json()) as T;
  };
  const [file, distances] = await Promise.all([get<QuizDataFile>('quiz-data.json'), get<DistanceFile>('country-distances.json')]);
  return buildQuizData(file, distances);
}

/** The quiz item a clicked feature counts as (itself, its merge parent, or null if not an item). */
export function resolveClick(data: QuizDataFile, scope: ScopeId, clicked: CountryId | null): CountryId | null {
  if (!clicked) return null;
  const id = data.merges[clicked] ?? clicked;
  return data.scopes[scope].includes(id) ? id : null;
}
