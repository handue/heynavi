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
  | { type: 'help' }
  /** "What's around me": describe the current view now (M3). */
  | { type: 'describe' }
  /** Step how much HeyNavi says on its own up or down. */
  | { type: 'more-updates' }
  | { type: 'fewer-updates' }
  /** Turn the proactive scene updates off or on (search and replies are unaffected). */
  | { type: 'updates-off' }
  | { type: 'updates-on' }
  /** A question about the surroundings ("where is the entrance", "what objects are nearby"). */
  | { type: 'ask'; question: string }
  /** Walking directions to a place on the map (M6): "navigate to the nearest pharmacy". */
  | { type: 'navigate'; destination: string }
  /** The next route step and what is left. */
  | { type: 'next-step' }
  /** The street and area from the map. */
  | { type: 'where-am-i' }
  | { type: 'stop-navigation' };

export type CommandType = Command['type'];

/**
 * Barge-in commands are the only ones acted on from INTERIM results (and while HeyNavi speaks):
 * they must cut speech off fast. Everything else waits for a final result.
 */
const BARGE_IN: ReadonlySet<CommandType> = new Set<CommandType>(['stop', 'cancel', 'quiet']);

export function isBargeIn(command: Command): boolean {
  return BARGE_IN.has(command.type);
}

/**
 * Commands the user may say over HeyNavi's speech without the wake phrase: the barge-ins, plus
 * requests about the speech or the updates themselves ("what's around me", "quieter", "pause").
 * HeyNavi's lines never contain these (voice audit), so they are also picked out of a transcript
 * glued to its echo. "find" is not one: HeyNavi's lines are full of object names.
 */
const OVER_SPEECH: ReadonlySet<CommandType> = new Set<CommandType>([
  ...BARGE_IN,
  'describe',
  'fewer-updates',
  'more-updates',
  'updates-off',
  'updates-on',
  'pause',
  'resume',
  'repeat',
  'help',
  // A whole question, or one said just before or after HeyNavi's echo (head/tail matching).
  'ask',
  // Route questions and ending a route, often said while a route line plays. No route line
  // starts with or contains these (route-tracker.test.ts voice audit).
  'next-step',
  'where-am-i',
  'stop-navigation',
]);

export function acceptedOverSpeech(command: Command): boolean {
  return OVER_SPEECH.has(command.type);
}

/** Same command (and, for find, the same concept). */
export function sameCommand(a: Command, b: Command): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'find') return b.type === 'find' && a.concept === b.concept;
  if (a.type === 'ask') return b.type === 'ask' && a.question === b.question;
  if (a.type === 'navigate') return b.type === 'navigate' && a.destination === b.destination;
  return true;
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

const EXACT: Readonly<Record<Exclude<CommandType, 'find' | 'ask' | 'navigate'>, readonly string[]>> = {
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
  describe: [
    "what's around me",
    'what is around me',
    'whats around me',
    "what's around",
    'what is around',
    "what's in front of me",
    'what is in front of me',
    'whats in front of me',
    "what's here",
    'what is here',
    'what do you see',
    'what can you see',
    'tell me what you see',
    'describe',
    'describe it',
    'describe this',
    'describe the scene',
    'describe the room',
    'describe what you see',
    'look around',
  ],
  'more-updates': [
    'more updates',
    'more update',
    'more detail',
    'more details',
    'more information',
    'tell me more',
    'talk more',
    'be more detailed',
  ],
  'fewer-updates': [
    'quieter',
    'be quieter',
    // Mishearings of "quieter" by on-device en-US. "spider" twice, said over HeyNavi's speech
    // (M3 final check and M4 round 1); an unlikely word to say to HeyNavi otherwise.
    'spider',
    'quitter',
    'quiet her',
    'quite her',
    'quiet or',
    'quieter mode',
    'be more quiet',
    'speak less',
    'less talk',
    'fewer updates',
    // Heard on the iPhone 16e for "fewer updates".
    'fewer update',
    'fear update',
    'fear updates',
    'few updates',
    'less updates',
    'less detail',
    'less details',
    'fewer details',
    'talk less',
    'less talking',
    'too much talking',
    'too much',
  ],
  'updates-off': [
    'updates off',
    'turn off updates',
    'turn updates off',
    'stop updates',
    'stop the updates',
    'pause updates',
    'pause the updates',
    'mute updates',
    'no more updates',
  ],
  'updates-on': [
    'updates on',
    'turn on updates',
    'turn updates on',
    'resume updates',
    'start updates',
    'unmute updates',
  ],
  // Not bare "next": HeyNavi's own "Next: in about …" would come back through the microphone.
  'next-step': [
    "what's next",
    'what is next',
    'whats next',
    'next step',
    'next turn',
    'next direction',
    'next instruction',
    'which way',
    'which way now',
    'which way do i go',
    'where do i turn',
    'where do i go',
    'how far',
    'how far is it',
    'how much further',
    'how much farther',
    'how far to go',
    'are we there yet',
  ],
  'where-am-i': [
    'where am i',
    'where am i now',
    'where are we',
    'where are we now',
    'what street am i on',
    'what street is this',
    "what's my location",
    'what is my location',
    'whats my location',
    'my location',
    'current location',
  ],
  'stop-navigation': [
    'stop navigation',
    'stop navigating',
    'stop the navigation',
    'end navigation',
    'end the navigation',
    'cancel navigation',
    'cancer navigation',
    'cancel the navigation',
    'exit navigation',
    'quit navigation',
    'navigation off',
    'end route',
    'end the route',
    'stop the route',
    'stop route',
    'cancel route',
    'cancel the route',
    'stop directions',
    'stop the directions',
    'cancel directions',
    'stop guiding',
  ],
};

const EXACT_LOOKUP: ReadonlyMap<string, Exclude<CommandType, 'find' | 'ask' | 'navigate'>> = new Map(
  (Object.entries(EXACT) as [Exclude<CommandType, 'find' | 'ask' | 'navigate'>, readonly string[]][]).flatMap(([type, phrases]) =>
    phrases.map((p) => [p, type] as const),
  ),
);

/**
 * How a request for walking directions starts, longest first (checked before the search verbs:
 * "show me the way to …"). None of HeyNavi's lines starts like this; "route to" is left out on
 * purpose, since route lines start with "Route to …".
 */
const NAVIGATE_VERBS = [
  'give me directions to',
  'get me directions to',
  'show me the way to',
  'show me how to get to',
  'how do i get to',
  'how can i get to',
  'how do i walk to',
  'i want to go to',
  'i need to go to',
  "i'd like to go to",
  'i would like to go to',
  'directions to',
  'direction to',
  'navigate me to',
  'navigate to',
  'navigation to',
  'take me to',
  'guide me to',
  'walk me to',
  'lead me to',
  'bring me to',
  'get me to',
  "let's go to",
  'lets go to',
  'go to',
  'navigate',
];
/** Said before the place without being part of what to search for. */
const PLACE_FILLERS = ['the nearest', 'a nearby', 'the closest', 'the nearby', 'nearest', 'closest', 'nearby', 'the', 'a', 'an', 'some'];
const MAX_PLACE_WORDS = 6;

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
  'show me',
];

/**
 * How a question starts (after "Hey Navi"). "Where is the entrance" is a question since M4: the
 * answer comes from the current view, and a search starts only if the thing is not in view.
 */
const QUESTION_FIRST_WORDS = new Set(['what', "what's", 'whats', "where's", 'wheres', "where're", 'which', "who's", 'whose']);
/**
 * Question words that start a question only with a verb after them: "where is the door", but not
 * "where you can allow the microphone" (a clause of a VoiceOver hint).
 */
const QUESTION_WORD_VERBS: Readonly<Record<string, ReadonlySet<string>>> = {
  where: new Set(['is', 'are', 'was', 'were', 'am', 'can', 'could', 'do', 'does', 'did', 'should', 'would']),
  who: new Set(['is', 'are', 'was', 'were']),
  how: new Set(['many', 'much', 'big', 'is', 'are', 'does', 'do', 'can']),
};
const QUESTION_OPENERS = [
  'is there',
  'are there',
  'is anyone',
  'is someone',
  'is anybody',
  'is somebody',
  'is something',
  'is anything',
  'can you see',
  'can you tell me',
  'could you tell me',
  'do you see',
  'tell me what',
  'tell me where',
  'tell me if',
  'tell me about',
];
const MAX_QUESTION_WORDS = 20;
/** Words a question can be made of without saying what it is about: "where is the" is not one yet. */
const QUESTION_GLUE = new Set([
  ...QUESTION_FIRST_WORDS,
  ...Object.keys(QUESTION_WORD_VERBS),
  'is', 'are', 'was', 'were', 'am', 'the', 'a', 'an', 'any', 'some', 'there', 'here', 'i', 'me', 'my',
  'you', 'your', 'do', 'does', 'did', 'can', 'could', 'should', 'would', 'see', 'tell', 'about', 'if',
  'of', 'in', 'on', 'at', 'to', 'many', 'much',
]);

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
  return { text, wake, command: text ? (matchCommand(text) ?? matchQuestion(text, rest)) : null };
}

/**
 * A question about the surroundings, or null. Checked after every other command, so "what can you
 * do" stays help and "what's around me" stays describe. `rest` still has its leading fillers:
 * "can you see a door" starts with the filler "can you".
 */
function matchQuestion(text: string, rest: string): Command | null {
  const startsQuestion = (t: string) => {
    const [first, second] = t.split(' ');
    return (
      QUESTION_FIRST_WORDS.has(first) ||
      (second != null && QUESTION_WORD_VERBS[first]?.has(second) === true) ||
      QUESTION_OPENERS.some((o) => startsWithPhrase(t, o))
    );
  };
  const question = [rest, text].find(startsQuestion);
  if (!question) return null;
  const words = question.split(' ');
  if (words.length < 2 || words.length > MAX_QUESTION_WORDS) return null;
  if (words.every((w) => QUESTION_GLUE.has(w))) return null;
  return { type: 'ask', question };
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
  for (const verb of NAVIGATE_VERBS) {
    if (text !== verb && startsWithPhrase(text, verb)) return navigateCommand(text.slice(verb.length).trim());
  }
  for (const verb of FIND_VERBS) {
    if (text !== verb && startsWithPhrase(text, verb)) {
      return findCommand(text.slice(verb.length).trim());
    }
  }
  return null;
}

function navigateCommand(phrase: string): Command | null {
  let place = phrase;
  for (let changed = true; changed; ) {
    changed = false;
    for (const filler of PLACE_FILLERS) {
      if (place !== filler && startsWithPhrase(place, filler)) {
        place = place.slice(filler.length).trim();
        changed = true;
      }
    }
  }
  const words = place.split(' ').filter(Boolean);
  if (words.length === 0 || words.length > MAX_PLACE_WORDS) return null;
  // "take me to it", "go to sleep there": no place.
  if (words.length === 1 && (NOT_AN_OBJECT.has(words[0]) || ['sleep', 'bed', 'settings'].includes(words[0]))) return null;
  return { type: 'navigate', destination: words.join(' ') };
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
  "what's around me",
  "what's in front of me",
  'where is',
  'what objects are nearby',
  'is there',
  'describe',
  'quieter',
  'more detail',
  'fewer updates',
  'more updates',
  'updates off',
  'updates on',
  'navigate to',
  'take me to',
  'directions to',
  "what's next",
  'where am i',
  'stop navigation',
  ...Object.keys(LEXICON),
];
