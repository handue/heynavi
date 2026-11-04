import { distanceM, type LatLon } from './geo.ts';

/**
 * Finding the place the user asked for, near them. On the 2026-11-03 outdoor test, 16 of 20
 * "navigate to …" searches failed: MapKit returned only places with that name more than 5 km away,
 * or nothing. Now, within a walk:
 * 1. the results for what was said whose names match it best (then the nearest);
 * 2. otherwise each meaningful word is searched on its own, and the nearby result whose name
 *    matches what was said best wins ("the science library" can find "Science Center" or
 *    "Main Library" instead of a library in another city);
 * 3. otherwise MapKit's nearest result for what was said, as before (a kind of place: "coffee
 *    shop" finds a cafe whose name shares no word with it).
 * A name only matches through a specific word: never through a number ("204 Elm St" for "room
 * 204") or a common word alone ("hall", "building").
 */
export type FoundPlace = { name: string; latitude: number; longitude: number };
export type Place = { name: string; point: LatLon; distance: number };
export type PlaceSearch = {
  place: Place | null;
  results: number;
  tries: number;
  via: 'as-said' | 'words' | 'nearest' | null;
};

/** Words that never identify a place. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'at', 'in', 'on', 'for', 'and', 'by', 'near', 'nearest', 'closest', 'nearby',
  'me', 'my', 'please', 'some', 'any', 'this', 'that', 'take', 'go', 'get', 'walk', 'way', 'want', 'with', 'from',
  'our', 'your', 'is', 'are', 'there', 'here', 'where',
]);
/** Kept for matching, but too common to search for alone or to match a name on their own. */
const GENERIC_WORDS = new Set([
  'building', 'hall', 'center', 'centre', 'room', 'place', 'area', 'street', 'road', 'house', 'office', 'shop', 'store',
  'entrance', 'main',
]);
/** At most this many single-word searches after the first one. */
const MAX_WORD_TRIES = 3;

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** The words of a query that identify a place, in order. */
export function placeWords(query: string): string[] {
  return [...new Set(words(query).filter((w) => !STOP_WORDS.has(w)))];
}

const isNumber = (w: string) => /^\d+$/.test(w);
const isSpecific = (w: string) => !GENERIC_WORDS.has(w) && !isNumber(w);

function editDistanceAtMost1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * A said word matches a name word: equal; a shortened word of 5+ letters ("engin" for
 * "engineering", but not "park" for "parking"); a plural ("bookstores"); or one letter off (5+).
 */
function sameWord(said: string, name: string): boolean {
  if (said === name) return true;
  if (said.length >= 5 && name.startsWith(said)) return true;
  if (name.length >= 5 && said.startsWith(name) && said.length - name.length <= 2) return true;
  return said.length >= 5 && name.length >= 5 && editDistanceAtMost1(said, name);
}

/**
 * How well `name` matches the said place words, 0 to 1 (common words and numbers count half).
 * 0 unless at least one specific word matches.
 */
export function nameScore(saidWords: readonly string[], name: string): number {
  if (saidWords.length === 0) return 0;
  const nameWords = words(name);
  const weight = (w: string) => (isSpecific(w) ? 1 : 0.5);
  const matched = saidWords.filter((s) => nameWords.some((n) => sameWord(s, n)));
  if (!matched.some(isSpecific)) return 0;
  const total = saidWords.reduce((sum, w) => sum + weight(w), 0);
  return matched.reduce((sum, w) => sum + weight(w), 0) / total;
}

/** The single words worth searching for alone: specific ones first (longest), at most MAX_WORD_TRIES. */
export function wordQueries(query: string): string[] {
  return placeWords(query)
    .filter((w) => !GENERIC_WORDS.has(w) && (w.length >= 3 || isNumber(w)))
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_WORD_TRIES);
}

function within(found: readonly FoundPlace[], from: LatLon, maxM: number): Place[] {
  return found
    .map((p) => ({ name: p.name, point: { lat: p.latitude, lon: p.longitude } }))
    .map((p) => ({ ...p, distance: distanceM(from, p.point) }))
    .filter((p) => p.distance <= maxM);
}

/** The best name match among `places` (then the nearest), or null when none matches. */
function bestMatch(places: readonly Place[], said: readonly string[]): Place | null {
  let best: { place: Place; score: number } | null = null;
  for (const place of places) {
    const score = nameScore(said, place.name);
    if (score === 0) continue;
    if (!best || score > best.score || (score === best.score && place.distance < best.place.distance)) best = { place, score };
  }
  return best?.place ?? null;
}

/**
 * The place for `query` within `maxM` of `from`. `search` runs one map search and never throws (a
 * failed search returns no places); `isCurrent` stops the extra searches once the request is
 * replaced or stopped.
 */
export async function findPlace(
  query: string,
  from: LatLon,
  maxM: number,
  search: (query: string) => Promise<FoundPlace[]>,
  isCurrent: () => boolean = () => true,
): Promise<PlaceSearch> {
  const said = placeWords(query);
  const first = await search(query);
  const firstNear = within(first, from, maxM);
  const named = bestMatch(firstNear, said);
  if (named) return { place: named, results: first.length, tries: 1, via: 'as-said' };

  let results = first.length;
  let tries = 1;
  const byWord: Place[] = [];
  for (const word of wordQueries(query)) {
    if (!isCurrent()) break;
    const found = await search(word);
    tries++;
    results += found.length;
    byWord.push(...within(found, from, maxM));
  }
  const similar = bestMatch(byWord, said);
  if (similar) return { place: similar, results, tries, via: 'words' };

  const nearest = [...firstNear].sort((a, b) => a.distance - b.distance)[0];
  return { place: nearest ?? null, results, tries, via: nearest ? 'nearest' : null };
}
