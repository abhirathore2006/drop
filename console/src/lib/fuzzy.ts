// A tiny subsequence fuzzy matcher for the command palette — no dependency, ~40 lines.
// "stk" matches "stacks", "myapp" matches "my-app". Scoring rewards contiguous runs,
// word-boundary starts (after a space/-/_/./:), and an early first match, so exact
// prefixes and word-starts rank above scattered hits.

const BOUNDARY = /[\s\-_./:]/;

/** Score `query` against `target` (both matched case-insensitively). Returns a number
 *  (higher = better) when every query char appears in order, or null when it doesn't.
 *  An empty query matches everything with a neutral score of 0. */
export function subsequenceScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;

  let ti = 0;
  let score = 0;
  let run = 0; // length of the current contiguous run
  let firstIdx = -1;
  let prev = -1;

  for (const ch of q) {
    let found = -1;
    for (; ti < t.length; ti++) {
      if (t[ti] === ch) {
        found = ti;
        break;
      }
    }
    if (found === -1) return null;
    if (firstIdx === -1) firstIdx = found;

    if (found === prev + 1) {
      run += 1;
      score += 3 + run; // contiguous — the more we chain, the better
    } else {
      run = 0;
      score += 1;
    }
    // a match at the very start or right after a word boundary is meaningful
    if (found === 0 || (found > 0 && BOUNDARY.test(t[found - 1]!))) score += 4;

    prev = found;
    ti = found + 1;
  }

  // reward an early first match, and a short target (a tighter fit)
  score += Math.max(0, 6 - firstIdx);
  score += Math.max(0, 12 - t.length) * 0.1;
  return score;
}

export interface Ranked<T> {
  item: T;
  score: number;
}

/** Rank `items` by how well `query` fuzzy-matches `key(item)`. Non-matches are dropped;
 *  ties keep the input order (stable). An empty query returns every item, order preserved. */
export function fuzzyRank<T>(query: string, items: readonly T[], key: (item: T) => string): Ranked<T>[] {
  const scored: (Ranked<T> & { i: number })[] = [];
  items.forEach((item, i) => {
    const score = subsequenceScore(query, key(item));
    if (score !== null) scored.push({ item, score, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map(({ item, score }) => ({ item, score }));
}
