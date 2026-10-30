/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONTEXTUAL_STRINGS,
  LEXICON,
  analyze,
  isBargeIn,
  normalize,
  parse,
  sameCommand,
  type Command,
} from './command-grammar.ts';

const find = (concept: string, spoken = concept): Command => ({ type: 'find', concept, spoken });

describe('normalize', () => {
  it('lowercases, drops punctuation, collapses spaces and repeated words', () => {
    assert.equal(normalize('  Hey,  NAVI — Stop!! '), 'hey navi stop');
    assert.equal(normalize('Where’s my phone?'), "where's my phone");
    assert.equal(normalize('stop stop stop'), 'stop');
    assert.equal(normalize("'quoted' t-shirt"), 'quoted t-shirt');
  });
});

describe('find', () => {
  it('starts a search from the common phrasings', () => {
    assert.deepEqual(parse('Find a chair.'), find('chair'));
    assert.deepEqual(parse('Hey Navi, find a chair'), find('chair'));
    assert.deepEqual(parse('look for my mug'), find('cup', 'mug'));
    assert.deepEqual(parse('search for a seat'), find('chair', 'seat'));
    assert.deepEqual(parse('search a chair'), find('chair'));
    assert.deepEqual(parse('Hey Navi search the door'), find('door'));
    assert.equal(parse('search'), null);
    assert.equal(parse('end search'), null);
    assert.equal(parse('Search paused.'), null);
    assert.equal(parse('search stopped'), null);
    assert.deepEqual(parse('where is the door'), find('door'));
    assert.deepEqual(parse("where's my phone"), find('phone'));
    assert.deepEqual(parse('where are my keys'), find('keys'));
    assert.deepEqual(parse('show me the sofa'), find('couch', 'sofa'));
    assert.deepEqual(parse('locate the bin'), find('trash can', 'bin'));
    assert.deepEqual(parse('can you find my wallet'), find('wallet'));
    assert.deepEqual(parse("I'm looking for my glasses"), find('glasses'));
    assert.deepEqual(parse('help me find the remote control'), find('remote', 'remote control'));
  });

  it('folds synonyms and plurals through the lexicon', () => {
    assert.deepEqual(parse('find chairs'), find('chair', 'chairs'));
    assert.deepEqual(parse('find someone'), find('person', 'someone'));
    assert.deepEqual(parse('find people'), find('person', 'people'));
    assert.deepEqual(parse('find my backpack'), find('bag', 'backpack'));
    assert.deepEqual(parse('find my cell phone'), find('phone', 'cell phone'));
    assert.deepEqual(parse('find the television'), find('tv', 'television'));
    assert.deepEqual(parse('find the refrigerator'), find('fridge', 'refrigerator'));
    assert.deepEqual(parse('find a doorway'), find('door', 'doorway'));
    assert.deepEqual(parse('find my shoes'), find('shoe', 'shoes'));
    assert.deepEqual(parse('find my water bottle'), find('bottle', 'water bottle'));
  });

  it('knows about 30 everyday objects, each reachable by every synonym', () => {
    const concepts = Object.keys(LEXICON);
    assert.ok(concepts.length >= 28 && concepts.length <= 32, `${concepts.length} concepts`);
    for (const [concept, words] of Object.entries(LEXICON)) {
      for (const word of words) assert.deepEqual(parse(`find the ${word}`), find(concept, word), word);
    }
  });

  it('strips fillers, determiners, possessives and locations', () => {
    assert.deepEqual(parse('find a chair please'), find('chair'));
    assert.deepEqual(parse('find a chair for me'), find('chair'));
    assert.deepEqual(parse('find the chair now'), find('chair'));
    assert.deepEqual(parse('find the door again'), find('door'));
    assert.deepEqual(parse('find the cup on the table'), find('cup'));
    assert.deepEqual(parse('find a chair to sit on'), find('chair'));
    assert.deepEqual(parse("find my mom's keys"), find('keys'));
    assert.deepEqual(parse('no, find the cup'), find('cup'));
  });

  it('passes an unknown noun phrase of up to 3 words to SAM as said', () => {
    assert.deepEqual(parse('find my blue water bottle'), find('blue water bottle'));
    assert.deepEqual(parse('find a red umbrella'), find('red umbrella'));
    assert.deepEqual(parse('where is the light switch'), find('light switch'));
  });

  it('rejects vague requests, questions, negations and long phrases', () => {
    for (const text of [
      'find',
      'find nothing',
      "don't find a chair",
      'do not find the door',
      'find it',
      'where is it',
      'find out',
      'show me around',
      'find something',
      'find in the kitchen',
      'find a chair and a table',
      'find chair or table',
      'find my big old blue water bottle',
      'what did you find',
      'did you find a chair',
      'how do I find the door',
    ]) {
      assert.equal(parse(text), null, text);
    }
  });

  it('drops trailing fillers, hedges and the wake phrase from the object', () => {
    assert.deepEqual(parse('find a chair okay'), find('chair'));
    assert.deepEqual(parse('find the door um'), find('door'));
    assert.deepEqual(parse('find a cup uh'), find('cup'));
    assert.deepEqual(parse('find a chair yeah'), find('chair'));
    assert.deepEqual(parse('find the cup ok'), find('cup'));
    assert.deepEqual(parse('find the door instead'), find('door'));
    assert.deepEqual(parse('find my keys quickly'), find('keys'));
    assert.deepEqual(parse('find a chair hey navi'), find('chair'));
    assert.deepEqual(parse('never mind find the door instead'), find('door'));
    assert.deepEqual(parse('actually find the cup'), find('cup'));
  });

  it('takes the known object out of "X of Y" and drops a number in front', () => {
    assert.deepEqual(parse('find a cup of coffee'), find('cup'));
    assert.deepEqual(parse('find a bottle of water'), find('bottle'));
    assert.deepEqual(parse('find a glass of water'), find('glass of water'));
    assert.deepEqual(parse('find two chairs'), find('chair', 'chairs'));
    assert.deepEqual(parse('find 2 chairs'), find('chair', 'chairs'));
    // A command word inside a real object name stays.
    assert.deepEqual(parse('find the stop sign'), find('stop sign'));
    assert.deepEqual(parse('find the bus stop'), find('bus stop'));
  });

  it('rejects pronouns and non-objects', () => {
    for (const text of ['find none', 'find whatever', 'find myself', 'find yourself', 'find one']) {
      assert.equal(parse(text), null, text);
    }
  });

  it("does not take HeyNavi's own words for a request", () => {
    assert.equal(parse('Looking for a chair. Move your phone slowly.'), null);
    assert.equal(parse('looking for a chair'), null);
    assert.equal(parse('Looking for a door again.'), null);
    assert.equal(parse('I found a chair, on the left of the camera view.'), null);
  });
});

describe('stop, cancel, quiet', () => {
  it('tells the three meanings apart', () => {
    for (const text of ['stop', 'Stop.', 'please stop', 'stop stop', 'stop it', 'okay stop', 'Hey Navi, stop']) {
      assert.deepEqual(parse(text), { type: 'stop' }, text);
    }
    for (const text of [
      'cancel',
      'stop searching',
      'stop looking',
      'never mind',
      'nevermind',
      'forget it',
      'stop looking for my keys',
      'Hey Navi, stop searching for the chair',
      // The on-device recognizer's usual mishearing of "cancel".
      'Cancer',
      'hey navi cancer that',
    ]) {
      assert.deepEqual(parse(text), { type: 'cancel' }, text);
    }
    for (const text of ['quiet', 'be quiet', 'stop talking', 'shh', 'Shhh', 'hush']) {
      assert.deepEqual(parse(text), { type: 'quiet' }, text);
    }
  });

  it('never stops on a negation or on a sentence that only contains the word', () => {
    for (const text of ["don't stop", 'do not stop', 'Stopped searching.', 'or tap stop', 'stop the car now please and']) {
      assert.equal(parse(text), null, text);
    }
  });

  it('understands the usual ways of insisting', () => {
    for (const text of ['just stop', 'stop already', 'yes stop', 'i said stop', 'Hey Navi, I said stop', 'actually stop']) {
      assert.deepEqual(parse(text), { type: 'stop' }, text);
    }
    for (const text of ['stop searching for now', 'stop searching for', 'never mind stop looking']) {
      assert.deepEqual(parse(text), { type: 'cancel' }, text);
    }
  });

  it('marks only stop, cancel and quiet as barge-in', () => {
    const all: Command[] = [
      { type: 'stop' },
      { type: 'cancel' },
      { type: 'quiet' },
      { type: 'pause' },
      { type: 'resume' },
      { type: 'repeat' },
      { type: 'help' },
      find('chair'),
    ];
    assert.deepEqual(
      all.filter(isBargeIn).map((c) => c.type),
      ['stop', 'cancel', 'quiet'],
    );
  });
});

describe('pause, resume, repeat, help', () => {
  it('matches each phrasing', () => {
    const cases: [string, Command['type']][] = [
      ['pause', 'pause'],
      ['pause search', 'pause'],
      ['hold on', 'pause'],
      ['wait', 'pause'],
      ['pause for a second', 'pause'],
      ['stop for a second', 'pause'],
      ['wait a sec', 'pause'],
      ['hold on a minute', 'pause'],
      ['hang on one moment', 'pause'],
      ['pause for now', 'pause'],
      ['keep going', 'resume'],
      ['resume', 'resume'],
      ['continue', 'resume'],
      ['keep looking', 'resume'],
      ['go on', 'resume'],
      ['start again', 'resume'],
      ['repeat', 'repeat'],
      ['repeat that', 'repeat'],
      ['say that again', 'repeat'],
      ['what did you say', 'repeat'],
      ['again', 'repeat'],
      ['help', 'help'],
      ['what can I say', 'help'],
      ['Hey Navi, help', 'help'],
    ];
    for (const [text, type] of cases) assert.equal(parse(text)?.type, type, text);
  });

  it('does not pause for a remark to someone else', () => {
    for (const text of ['wait for me', 'can you wait for me', 'hold on for me', 'wait for it']) {
      assert.equal(parse(text), null, text);
    }
  });
});

describe('wake phrase', () => {
  it('is optional and recognized with common mishearings', () => {
    for (const text of ['Hey Navi, stop', 'hi navi stop', 'hey navy stop', 'hey nav stop', 'HeyNavi stop', 'Navi stop']) {
      const a = analyze(text);
      assert.equal(a.wake, true, text);
      assert.deepEqual(a.command, { type: 'stop' }, text);
    }
    assert.equal(analyze('stop').wake, false);
  });

  it('reports unknown speech after it, so the app can say it did not understand', () => {
    const a = analyze("Hey Navi, what's the weather");
    assert.equal(a.wake, true);
    assert.equal(a.command, null);
    assert.ok(a.text.length > 0);
    assert.deepEqual(analyze('hey navi'), { text: '', wake: true, command: null });
    assert.equal(analyze("what's the weather").wake, false);
    // "navy" alone is an ordinary word, not the wake phrase.
    assert.equal(analyze('navy blue').wake, false);
  });
});

describe('sameCommand and contextual strings', () => {
  it('compares find by concept', () => {
    assert.equal(sameCommand(find('chair'), find('chair', 'seat')), true);
    assert.equal(sameCommand(find('chair'), find('cup')), false);
    assert.equal(sameCommand({ type: 'stop' }, { type: 'stop' }), true);
    assert.equal(sameCommand({ type: 'stop' }, { type: 'cancel' }), false);
  });

  it('biases the recognizer toward the wake phrase, commands and lexicon nouns', () => {
    for (const s of ['Hey Navi', 'stop', 'find', 'repeat', 'pause', 'resume', 'chair', 'keys']) {
      assert.ok(CONTEXTUAL_STRINGS.includes(s), s);
    }
    assert.ok(CONTEXTUAL_STRINGS.length <= 100);
  });
});

describe('scene commands (M3)', () => {
  it('parses describe, verbosity and update toggles', () => {
    const cases: [string, string][] = [
      ["Hey Navi, what's around me?", 'describe'],
      ['What is in front of me', 'describe'],
      ['what do you see', 'describe'],
      ['describe the scene please', 'describe'],
      ['look around', 'describe'],
      ['more updates', 'more-updates'],
      ['tell me more', 'more-updates'],
      ['fewer updates', 'fewer-updates'],
      ['Fear update', 'fewer-updates'],
      ['quieter please', 'fewer-updates'],
      ['less detail please', 'fewer-updates'],
      ['updates off', 'updates-off'],
      ['stop updates', 'updates-off'],
      ['pause updates', 'updates-off'],
      ['turn on updates', 'updates-on'],
      ['resume updates', 'updates-on'],
    ];
    for (const [text, type] of cases) assert.equal(parse(text)?.type, type, text);
  });

  it('keeps "look for" a search and plain "stop" a stop', () => {
    assert.deepEqual(parse('look for a chair'), { type: 'find', concept: 'chair', spoken: 'chair' });
    assert.deepEqual(parse('stop'), { type: 'stop' });
    assert.equal(parse('updates'), null);
  });
});
