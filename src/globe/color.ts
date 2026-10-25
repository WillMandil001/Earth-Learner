const cache = new Map<string, string>();

function parseHex(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Linear mix of two #rrggbb colours; t = 0 gives `a`. Results are cached. */
export function mix(a: string, b: string, t: number): string {
  const key = `${a}|${b}|${t}`;
  let out = cache.get(key);
  if (!out) {
    const ca = parseHex(a);
    const cb = parseHex(b);
    const c = ca.map((v, i) => Math.round(v + (cb[i]! - v) * t));
    out = `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    cache.set(key, out);
  }
  return out;
}
