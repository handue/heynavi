/**
 * English voice command grammar (ARCHITECTURE 9, 7.1). Pure: text in, Command out, well under 1 ms.
 *
 * A transcript is a command only when the WHOLE utterance (after an optional "Hey Navi" and a
 * little politeness) is one: "stop", "please stop", "find my keys". A sentence that merely
 * contains a command word ("Stopped searching.", "or tap Stop") is not. That is the first line of
 * defence against the app hearing its own speech; echo-gate.ts is the second.
 */

export type Command =
  | {
      type: 'find';
      /** English noun phrase for SAM: a lexicon concept ("chair") or the phrase itself. */
      concept: string;
      /** The noun phrase as the user said it, without determiners ("my mug" -> "mug"). */
      spoken: string;
    }
  /** If HeyNavi is speaking, stop the speech only; otherwise stop the search. */
  | { type: 'stop' }
  /** Stop the search and any speech. */
  | { type: 'cancel' }
  /** Stop the speech only. */
  | { type: 'quiet' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'repeat' }
  | { type: 'help' };

export type CommandType = Command['type'];

/**
 * Barge-in commands are the only ones acted on from INTERIM results (and while HeyNavi speaks):
 * they must cut speech off fast. Everything else waits for a final result.
 */
const BARGE_IN: ReadonlySet<CommandType> = new Set<CommandType>(['stop', 'cancel', 'quiet']);

export function isBargeIn(command: Command): boolean {
  return BARGE_IN.has(command.type);
}

/** Same command (and, for find, the same concept). */
export function sameCommand(a: Command, b: Command): boolean {
  if (a.type !== b.type) return false;
  return a.type !== 'find' || (b.type === 'find' && a.concept === b.concept);
}

/**
 * Everyday objects -> the concept sent to SAM. SAM 3.1 is open-vocabulary, so a noun phrase
 * that is not here is still searched for as said; the lexicon only folds synonyms and plurals.
 */
export const LEXICON: Readonly<Record<string, readonly string[]>> = {
  chair: ['chair', 'chairs', 'seat', 'seats', 'armchair', 'armchairs'],
  cup: ['cup', 'cups', 'mug', 'mugs', 'coffee cup', 'coffee cups', 'coffee mug', 'coffee mugs'],
  bottle: ['bottle', 'bottles', 'water bottle', 'water bottles'],
  door: ['door', 'doors', 'doorway', 'doorways'],
  person: ['person', 'persons', 'people', 'someone', 'somebody', 'anyone', 'anybody'],
  bag: ['bag', 'bags', 'backpack', 'backpacks', 'purse', 'purses', 'handbag', 'handbags'],
  table: ['table', 'tables', 'dining table'],
  couch: ['couch', 'couches', 'sofa', 'sofas'],
  bed: ['bed', 'beds'],
  laptop: ['laptop', 'laptops', 'laptop computer'],
  phone: ['phone', 'phones', 'cell phone', 'cell phones', 'cellphone', 'mobile phone', 'smartphone', 'iphone'],
  keys: ['keys', 'key', 'car keys', 'house keys'],
  book: ['book', 'books'],
  glasses: ['glasses', 'eyeglasses', 'reading glasses', 'spectacles'],
  remote: ['remote', 'remotes', 'remote control', 'tv remote'],
  shoe: ['shoe', 'shoes', 'sneaker', 'sneakers'],
  dog: ['dog', 'dogs', 'puppy'],
  cat: ['cat', 'cats', 'kitten'],
  'trash can': ['trash can', 'trash cans', 'trashcan', 'trash bin', 'bin', 'bins', 'garbage can', 'wastebasket'],
  sink: ['sink', 'sinks'],
  toilet: ['toilet', 'toilets'],
  window: ['window', 'windows'],
  stairs: ['stairs', 'stair', 'staircase', 'stairway'],
  tv: ['tv', 'tvs', 't v', 'television', 'televisions'],
  plant: ['plant', 'plants', 'potted plant', 'houseplant'],
  umbrella: ['umbrella', 'umbrellas'],
  wallet: ['wallet', 'wallets'],
  fridge: ['fridge', 'fridges', 'refrigerator', 'refrigerators'],
  microwave: ['microwave', 'microwaves', 'microwave oven'],
};

const SYNONYMS: ReadonlyMap<string, string> = new Map(
  Object.entries(LEXICON).flatMap(([concept, words]) => words.map((w) => [w, concept] as const)),
);

/**
 * "Hey Navi" and how the on-device recognizer tends to hear it. Optional in the foreground app;
 * it marks speech as meant for HeyNavi (unknown speech with it gets a "didn't catch that").
 * Bare "navy" and "nav" are left out on purpose: they are ordinary words.
 */
const WAKE_PREFIXES = [
  'hey navi',
  'hi navi',
  'heynavi',
  'hey navy',
  'hi navy',
  'hey navvy',
  'hey navie',
  'hey nav',
  'okay navi',
  'ok navi',
  'navi',
] as const;

/**
 * Said before a command without changing it: "okay stop", "no, find the cup", "can you ...",
 * "I said stop", "never mind, find the door". Never stripped when it is all there is.
 */
const LEADING_FILLERS = [
  'can you please',
  'could you please',
  'can you',
  'could you',
  'would you',
  'will you',
  'never mind',
  'nevermind',
  'i said',
  'actually',
  'please',
  'okay',
  'just',
  'yes',
  'ok',
  'no',
  'oh',
  'um',
  'uh',
  'hey',
];
/** Said after a command: "find a chair okay", "stop already", "find the door instead". */
const TRAILING_FILLERS = [
  'for me',
  'for now',
  'right now',
  'thank you',
  'please',
  'now',
  'thanks',
  'already',
  'instead',
  'quickly',
  'okay',
  'ok',
  'yeah',
  'right',
  'um',
  'uh',
];
/** "wait for me" is said to a person; "find a chair for me" is a request. */
const KEEP_FOR_ME = new Set(['wait', 'hold on', 'hang on']);
/** "pause for a second", "hold on a minute", "stop for a moment": a pause, not an end. */
const MOMENTS = ['a second', 'a sec', 'a moment', 'a minute', 'one second', 'one sec', 'one moment', 'one minute'];
const PAUSE_VERBS = ['pause', 'wait', 'hold on', 'hang on', 'stop'];
const PAUSE_FOR_A_MOMENT = PAUSE_VERBS.flatMap((verb) => MOMENTS.flatMap((m) => [`${verb} ${m}`, `${verb} for ${m}`]));

const EXACT: Readonly<Record<Exclude<CommandType, 'find'>, readonly string[]>> = {
  stop: ['stop', 'stop it', 'stop that'],
  cancel: [
    'cancel',
    'cancel it',
    'cancel that',
    // On the iPhone 16e, on-device en-US hears "cancel" as "cancer" more often than not.
    'cancer',
    'cancer it',
    'cancer that',
    'cancel search',
    'cancel the search',
    'stop searching',
    'stop looking',
    'stop search',
    'stop the search',
    'never mind',
    'nevermind',
    'forget it',
  ],
  quiet: ['quiet', 'be quiet', 'stop talking', 'stop speaking', 'hush', 'shush', 'silence', 'shut up'],
  pause: [
    'pause',
    'pause it',
    'pause search',
    'pause the search',
    'pause searching',
    'hold on',
    'hold on a second',
    'hang on',
    'wait',
    ...PAUSE_FOR_A_MOMENT,
  ],
  resume: [
    'resume',
    'resume search',
    'resume the search',
    'resume searching',
    'continue',
    'continue searching',
    'keep looking',
    'keep searching',
    'keep going',
    'go on',
    'carry on',
    'start again',
  ],
  repeat: [
    'repeat',
    'repeat that',
    'repeat it',
    'say that again',
    'say it again',
    'say again',
    'what did you say',
    'again',
    'come again',
    'pardon',
  ],
  help: ['help', 'help me', 'what can i say', 'what can you do'],
};

const EXACT_LOOKUP: ReadonlyMap<string, Exclude<CommandType, 'find'>> = new Map(
  (Object.entries(EXACT) as [Exclude<CommandType, 'find'>, readonly string[]][]).flatMap(([type, phrases]) =>
    phrases.map((p) => [p, type] as const),
  ),
);

/**
 * Verbs that start a search, longest first. Bare "looking for" is NOT one: it is how HeyNavi's
 * own "Looking for a chair." would come back through the microphone.
 */
const FIND_VERBS = [
  "i'm looking for",
  'i am looking for',
  'help me find',
  'i need to find',
  'i want to find',
  'search for',
  // "search a chair": heard on the iPhone 16e.
  'search',
  'look for',
  'find me',
  'find',
  'locate',
  'where is',
  "where's",
  'wheres',
  'where are',
  "where're",
  'show me',
];

const DETERMINERS = new Set([
  'my',
  'a',
  'an',
  'the',
  'some',
  'your',
  'our',
  'his',
  'her',
  'their',
  'any',
  'all',
  'another',
  'this',
  'that',
  'these',
  'those',
]);

/** A number in front of the object ("find two chairs") says how many, not what. */
const QUANTITY_RE = /^(\d+|one|two|three|four|five|six|seven|eight|nine|ten)$/;

/** A location or clause after the object ends the noun phrase: "the cup on the table" -> "cup". */
const PHRASE_ENDERS = new Set([
  'on',
  'in',
  'near',
  'under',
  'by',
  'at',
  'around',
  'inside',
  'behind',
  'beside',
  'next',
  'over',
  'from',
  'with',
  'to',
  'for',
  'that',
  'which',
  'who',
  'somewhere',
  'again',
]);

/** Words that make a "find" request vague, a question, or a negation: no search starts. */
const NOT_AN_OBJECT = new Set([
  'nothing',
  'anything',
  'something',
  'everything',
  'it',
  'its',
  'them',
  'they',
  'him',
  'her',
  'me',
  'you',
  'us',
  'one',
  'out',
  'way',
  'what',
  'where',
  'who',
  'how',
  'why',
  'which',
  'when',
  'there',
  'here',
  'help',
  'not',
  'no',
  "don't",
  'dont',
  'never',
  'or',
  'and',
  'but',
  'if',
  'is',
  'are',
  'was',
  'be',
  'can',
  'do',
  'does',
  'did',
  'thing',
  'things',
  'stuff',
  'place',
  'spot',
  'none',
  'whatever',
  'myself',
  'yourself',
  'himself',
  'herself',
  'itself',
  'ourselves',
  'themselves',
  // Status words after "search": HeyNavi's own "Search paused." style lines.
  'paused',
  'stopped',
  'ended',
  'started',
  'cancelled',
  'canceled',
  'resumed',
  'done',
  'over',
]);

/** What SAM accepts as a concept (the backend validates the same shape). */
const CONCEPT_RE = /^[a-z][a-z -]{0,63}$/;
const MAX_PHRASE_WORDS = 3;

/**
 * Lowercase, apostrophes unified, punctuation removed, spaces collapsed, and a word repeated
 * back to back said once ("stop stop" -> "stop").
 */
export function normalize(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[^a-z0-9' -]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
    .filter((w) => w.length > 0);
  return words.filter((w, i) => w !== words[i - 1]).join(' ');
}

function startsWithPhrase(text: string, phrase: string): boolean {
  return text === phrase || text.startsWith(`${phrase} `);
}

function endsWithPhrase(text: string, phrase: string): boolean {
  return text === phrase || text.endsWith(` ${phrase}`);
}

/** Removes a leading wake phrase from normalized text. */
export function stripWake(normalized: string): { wake: boolean; rest: string } {
  for (const prefix of WAKE_PREFIXES) {
    if (startsWithPhrase(normalized, prefix)) {
      return { wake: true, rest: normalized.slice(prefix.length).trim() };
    }
  }
  return { wake: false, rest: normalized };
}

function stripFillers(text: string): string {
  let rest = text;
  for (let changed = true; changed && rest.length > 0; ) {
    changed = false;
    for (const filler of LEADING_FILLERS) {
      // Never strip the command itself: "help" alone, "no" alone.
      if (rest !== filler && startsWithPhrase(rest, filler)) {
        rest = rest.slice(filler.length).trim();
        changed = true;
        break;
      }
    }
    for (const filler of TRAILING_FILLERS) {
      if (rest !== filler && endsWithPhrase(rest, filler)) {
        const before = rest.slice(0, rest.length - filler.length).trim();
        if (filler === 'for me' && KEEP_FOR_ME.has(before)) continue;
        rest = before;
        changed = true;
        break;
      }
    }
    // "find a chair, hey Navi": the wake phrase at the end adds nothing either.
    for (const wake of WAKE_PREFIXES) {
      if (rest !== wake && endsWithPhrase(rest, wake)) {
        rest = rest.slice(0, rest.length - wake.length).trim();
        changed = true;
        break;
      }
    }
  }
  return rest;
}

export type Analysis = {
  /** Normalized text after the wake phrase and fillers were removed. */
  text: string;
  /** The utterance started with "Hey Navi" (or a common mishearing of it). */
  wake: boolean;
  command: Command | null;
};

export function analyze(transcript: string): Analysis {
  const { wake, rest } = stripWake(normalize(transcript));
  const text = stripFillers(rest);
  return { text, wake, command: text ? matchCommand(text) : null };
}

export function parse(transcript: string): Command | null {
  return analyze(transcript).command;
}

function matchCommand(text: string): Command | null {
  const exact = EXACT_LOOKUP.get(text);
  if (exact) return { type: exact };
  // "stop looking for my keys", "cancel the search for the chair", "stop searching for".
  const forAt = text.endsWith(' for') ? text.length - 4 : text.indexOf(' for ');
  if (forAt > 0 && EXACT_LOOKUP.get(text.slice(0, forAt)) === 'cancel') return { type: 'cancel' };
  if (/^s?h{2,}$|^sh$/.test(text)) return { type: 'quiet' };
  for (const verb of FIND_VERBS) {
    if (text !== verb && startsWithPhrase(text, verb)) {
      return findCommand(text.slice(verb.length).trim());
    }
  }
  return null;
}

function findCommand(phrase: string): Command | null {
  let words = phrase.split(' ').filter(Boolean);
  // Trailing "again", then cut at the first location word or clause ("the cup on the table").
  const end = words.findIndex((w, i) => i > 0 && PHRASE_ENDERS.has(w));
  if (end > 0) words = words.slice(0, end);
  // Determiners, possessives and numbers in front: "my", "the", "mom's", "two".
  while (words.length > 1 && (DETERMINERS.has(words[0]) || /'s$/.test(words[0]) || QUANTITY_RE.test(words[0]))) {
    words = words.slice(1);
  }
  // "show me around", "find in the kitchen": no object at all.
  if (words.length === 0 || PHRASE_ENDERS.has(words[0])) return null;
  const spoken = words.join(' ');
  const known = SYNONYMS.get(spoken);
  if (known) return { type: 'find', concept: known, spoken };
  // "a cup of coffee", "a bottle of water": the object is the known noun before "of".
  const ofAt = words.indexOf('of');
  const head = ofAt > 0 ? words.slice(0, ofAt).join(' ') : '';
  const knownHead = head ? SYNONYMS.get(head) : undefined;
  if (knownHead) return { type: 'find', concept: knownHead, spoken: head };
  if (words.length > MAX_PHRASE_WORDS) return null;
  if (words.some((w) => NOT_AN_OBJECT.has(w) || DETERMINERS.has(w))) return null;
  if (!CONCEPT_RE.test(spoken)) return null;
  return { type: 'find', concept: spoken, spoken };
}

/**
 * contextualStrings for the recognizer: biases it toward the wake phrase, the command words and
 * the lexicon nouns (iOS SFSpeechRecognitionRequest.contextualStrings).
 */
export const CONTEXTUAL_STRINGS: readonly string[] = [
  'Hey Navi',
  'Navi',
  'find',
  'search',
  'search for',
  'look for',
  'where is',
  'stop',
  'cancel',
  'never mind',
  'be quiet',
  'pause',
  'resume',
  'keep looking',
  'repeat',
  'help',
  ...Object.keys(LEXICON),
];
