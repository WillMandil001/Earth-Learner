import type { TypoTolerance } from '../settings/schema';

/** Display name plus every accepted answer (raw; normalised at match time). */
export interface NameEntry {
  display: string;
  accepted: readonly string[];
}

/**
 * Canonical form of a typed or stored name: lowercase, no diacritics or
 * punctuation, "&" → "and", "st"/"st." → "saint", leading "the" dropped, and
 * spaces removed (so "Guinea Bissau", "Guinea-Bissau" and "GuineaBissau" agree).
 */
export function normaliseName(text: string): string {
  const words = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => (w === 'st' ? 'saint' : w));
  if (words[0] === 'the' && words.length > 1) words.shift();
  return words.join('');
}

/** Damerau–Levenshtein (optimal string alignment) distance, giving up above `max`. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2: number[] = new Array(b.length + 1).fill(0);
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2]! + 1);
      cur.push(d);
      rowMin = Math.min(rowMin, d);
    }
    if (rowMin > max) return max + 1;
    prev2.splice(0, prev2.length, ...prev);
    prev = cur;
  }
  return prev[b.length]!;
}

/** Allowed edit distance for a normalised answer of length `len`. */
export function typoAllowance(len: number, tolerance: TypoTolerance): number {
  if (tolerance === 'off') return 0;
  if (tolerance === 'normal') return len < 5 ? 0 : len < 10 ? 1 : 2;
  return len < 4 ? 0 : len < 8 ? 1 : 2;
}

/** Normalised names of a set of items (countries, cities…), keyed by item ID. */
export interface NameIndex {
  /** Normalised accepted names per item. */
  keys: Map<string, string[]>;
  /** Normalised name → items that accept it. */
  owners: Map<string, string[]>;
  display: Map<string, string>;
}

export function buildNameIndex(names: Readonly<Record<string, NameEntry>>, scope: Iterable<string>): NameIndex {
  const keys = new Map<string, string[]>();
  const owners = new Map<string, string[]>();
  const display = new Map<string, string>();
  for (const id of scope) {
    const n = names[id];
    if (!n) continue;
    display.set(id, n.display);
    const ks = [...new Set(n.accepted.map(normaliseName).filter(Boolean))];
    keys.set(id, ks);
    for (const k of ks) owners.set(k, [...(owners.get(k) ?? []), id]);
  }
  return { keys, owners, display };
}

/** Normalised names claimed by more than one item. */
export function nameCollisions(index: NameIndex): [string, string[]][] {
  return [...index.owners].filter(([, ids]) => ids.length > 1);
}

export type MatchResult =
  | { kind: 'empty' }
  | { kind: 'exact' }
  /** Accepted with a spelling slip; the UI shows the correct spelling. */
  | { kind: 'typo'; distance: number }
  /** `other` is the different item the answer matched, if any. */
  | { kind: 'wrong'; other: string | null };

/**
 * Judge a typed answer for `target`. Exact names win. Otherwise a near-miss is
 * accepted only if it is within the typo allowance of the target and of no
 * other candidate (so "Nigeria" never passes for Niger, nor "Austria" for Australia).
 *
 * `candidates` limits which other items count for the ambiguity guard (e.g. only
 * cities in the same country and its neighbours); by default every indexed item does.
 */
export function matchAnswer(
  index: NameIndex,
  target: string,
  text: string,
  tolerance: TypoTolerance,
  candidates?: ReadonlySet<string>,
): MatchResult {
  const key = normaliseName(text);
  if (!key) return { kind: 'empty' };
  const counts = (id: string) => id === target || !candidates || candidates.has(id);
  const exactOwners = (index.owners.get(key) ?? []).filter(counts);
  if (exactOwners.includes(target)) return { kind: 'exact' };
  if (exactOwners.length) return { kind: 'wrong', other: exactOwners[0]! };

  const max = typoAllowance(key.length, tolerance);
  if (max === 0) return { kind: 'wrong', other: null };
  let dTarget = max + 1;
  let other: string | null = null;
  let dOther = max + 1;
  for (const [id, ks] of index.keys) {
    if (!counts(id)) continue;
    for (const k of ks) {
      const d = editDistance(key, k, max);
      if (id === target) dTarget = Math.min(dTarget, d);
      else if (d < dOther) {
        dOther = d;
        other = id;
      }
    }
  }
  if (dOther <= max) return { kind: 'wrong', other };
  return dTarget <= max ? { kind: 'typo', distance: dTarget } : { kind: 'wrong', other: null };
}
