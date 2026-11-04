/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LatLon } from './geo.ts';
import { findPlace, nameScore, placeWords, wordQueries, type FoundPlace } from './place-search.ts';

const HERE: LatLon = { lat: 37.5, lon: 127.0 };
/** A place `northM` meters north of HERE. */
function at(name: string, northM: number): FoundPlace {
  return { name, latitude: HERE.lat + northM / 111_320, longitude: HERE.lon };
}

/** A fake map search: what each query returns, and the queries it was asked. */
function maps(table: Record<string, FoundPlace[]>) {
  const asked: string[] = [];
  return {
    asked,
    search: async (query: string) => {
      asked.push(query);
      return table[query] ?? [];
    },
  };
}

describe('place search near the user (campus test, 2026-11-03)', () => {
  it('takes the best name match for what was said, then the nearest', async () => {
    const m = maps({ 'science library': [at('Main Library', 200), at('Science Library', 600), at('Science Library', 9000)] });
    const found = await findPlace('science library', HERE, 5000, m.search);
    assert.equal(found.place?.name, 'Science Library');
    assert.ok(Math.abs((found.place?.distance ?? 0) - 600) < 1);
    assert.deepEqual([found.tries, found.via, found.results], [1, 'as-said', 3]);
    assert.deepEqual(m.asked, ['science library']);
  });

  it('finds a similar name nearby when the name as said only matches places far away', async () => {
    const m = maps({
      'the science library': [at('Science Library', 40_000)],
      science: [at('Science Center', 300), at('Computer Science Hall', 500)],
      library: [at('Main Library', 250), at('Science Library', 30_000)],
    });
    const found = await findPlace('the science library', HERE, 5000, m.search);
    // Each shares one of the two words: the nearest of them wins.
    assert.equal(found.place?.name, 'Main Library');
    assert.equal(found.via, 'words');
    assert.deepEqual(m.asked, ['the science library', 'science', 'library']);
  });

  it('prefers the name sharing more words, then the nearer one', async () => {
    const m = maps({ student: [at('Student Health', 100), at('Student Center', 350)] });
    // "center" is too common to search alone, but it still counts when names are compared.
    const found = await findPlace('student center', HERE, 5000, m.search);
    assert.equal(found.place?.name, 'Student Center');
    assert.deepEqual(m.asked, ['student center', 'student']);
  });

  it('still goes to the nearest place of the kind asked for when no name shares a word', async () => {
    const m = maps({ 'coffee shop': [at('Bluebird', 300), at('Daybreak', 120)], coffee: [at('Daybreak', 120)] });
    const found = await findPlace('coffee shop', HERE, 5000, m.search);
    assert.equal(found.place?.name, 'Daybreak');
    assert.equal(found.via, 'nearest');
  });

  it('never matches a name on a number or a common word alone', async () => {
    const m = maps({ '204': [at('204 Elm St', 100)], building: [at('Parking Building', 50)] });
    const found = await findPlace('engineering building room 204', HERE, 5000, m.search);
    assert.equal(found.place, null);
    assert.deepEqual(m.asked, ['engineering building room 204', 'engineering', '204']);
    assert.equal(nameScore(placeWords('the park'), 'Campus Parking Garage'), 0);
    assert.equal(nameScore(placeWords('main hall'), 'Main Hall'), 0, 'only common words');
  });

  it('forgives one misheard letter, a shortened word and a plural', () => {
    assert.equal(nameScore(placeWords('the libary'), 'Main Library'), 1);
    assert.equal(nameScore(placeWords('engin building'), 'Engineering Building'), 1);
    assert.equal(nameScore(placeWords('bookstores'), 'Campus Bookstore'), 1);
    assert.equal(nameScore(placeWords('gym'), 'Gymnasium'), 0, 'short words must match exactly');
  });

  it('says so when nothing fits, and stops searching once the request is replaced', async () => {
    const m = maps({ pharmacy: [at('Coffee Bean', 80)] });
    const found = await findPlace('nearest pharmacy', HERE, 5000, m.search);
    assert.deepEqual([found.place, found.via, found.tries], [null, null, 2]);

    const stopped = maps({});
    const late = await findPlace('engineering library annex', HERE, 5000, stopped.search, () => false);
    assert.deepEqual(stopped.asked, ['engineering library annex']);
    assert.equal(late.tries, 1);
  });

  it('searches at most three specific words, longest first, without filler or common words', () => {
    assert.deepEqual(wordQueries('the nearest engineering building room 204'), ['engineering', '204']);
    assert.deepEqual(wordQueries('please take me to the big old campus bookstore'), ['bookstore', 'campus', 'big']);
    assert.deepEqual(placeWords('the Student Center'), ['student', 'center']);
  });
});
