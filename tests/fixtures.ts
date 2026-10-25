import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCountryData } from '../src/data/loadCountries';
import { buildQuizData, type QuizData } from '../src/quiz/data';
import type { CountryData } from '../src/types';

const dir = join(import.meta.dirname, '..', 'public', 'data');
const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));

let cached: CountryData | null = null;

/** The committed datasets, decoded exactly as the app does. */
export function countryData(): CountryData {
  cached ??= buildCountryData(
    read('countries-110m.topo.json'),
    read('countries-50m.topo.json'),
    read('countries-meta.json'),
  );
  return cached;
}

let quiz: QuizData | null = null;

export function quizData(): QuizData {
  quiz ??= buildQuizData(read('quiz-data.json'), read('country-distances.json'));
  return quiz;
}
