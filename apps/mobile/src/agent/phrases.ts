/**
 * Every user-facing sentence. The hackathon MVP is English only (en-US); more languages are a
 * possible future enhancement. Positions are relative to the camera view and size is only
 * "looks close / far away": never meters, steps, or claims that something is safe.
 *
 * Voice audit (M2): the microphone hears every spoken line through the loudspeaker, and VoiceOver
 * reads the ui strings aloud. So no line, and no clause of a line, may parse as a voice command
 * ("Stop searching" became "End search"), and no line may contain the wake word ("HeyNavi
 * server" became "the server"). phrases.test.ts enforces both. The help line is the one
 * deliberate exception: it lists the commands, and the echo gate drops them while it plays.
 * It names no "stop", so the user's own "stop" can still cut it off.
 */
import type { Lang, Position, SearchStatus } from './types.ts';

export type ConceptId = 'chair' | 'cup' | 'bottle' | 'door' | 'person' | 'bag';

type NounForms = {
  en: string;
  enPlural: string;
  /** Said without "a"/"an": "Looking for keys." */
  pluralOnly?: boolean;
};

/** SAM English noun -> labels for common search targets (searches start by voice only). */
export const CONCEPTS: Record<ConceptId, NounForms> = {
  chair: { en: 'chair', enPlural: 'chairs' },
  cup: { en: 'cup', enPlural: 'cups' },
  bottle: { en: 'bottle', enPlural: 'bottles' },
  door: { en: 'door', enPlural: 'doors' },
  person: { en: 'person', enPlural: 'people' },
  bag: { en: 'bag', enPlural: 'bags' },
};

/** Spoken concepts (from voice) whose words need more than the regular rules. */
const OTHER_NOUNS: Record<string, NounForms> = {
  tv: { en: 'TV', enPlural: 'TVs' },
  keys: { en: 'keys', enPlural: 'keys', pluralOnly: true },
  glasses: { en: 'glasses', enPlural: 'glasses', pluralOnly: true },
  stairs: { en: 'stairs', enPlural: 'stairs', pluralOnly: true },
};

export const CONCEPT_IDS = Object.keys(CONCEPTS) as ConceptId[];

export function isConceptId(value: string): value is ConceptId {
  return Object.hasOwn(CONCEPTS, value);
}

/** Regular English plural of the last word: couch -> couches, trash can -> trash cans. */
export function pluralize(noun: string): string {
  if (/(s|x|z|ch|sh)$/.test(noun)) return `${noun}es`;
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

/** Other spoken goals fall back to the English noun itself. */
function labels(concept: string): NounForms {
  if (isConceptId(concept)) return CONCEPTS[concept];
  return OTHER_NOUNS[concept] ?? { en: concept, enPlural: pluralize(concept) };
}

/** Said without "a"/"an" and as plural: keys, glasses, stairs. */
export function isPluralOnly(concept: string): boolean {
  return labels(concept).pluralOnly === true;
}

/** Plural label: chair -> chairs, person -> people, keys -> keys. */
export function pluralLabel(concept: string): string {
  return labels(concept).enPlural;
}

/** Kept with a `lang` parameter so more languages can come back without touching callers. */
export function conceptLabel(concept: string, _lang: Lang = 'en-US'): string {
  return labels(concept).en;
}

// --- English helpers --------------------------------------------------------------------------

/** "a chair", "an umbrella", "keys". */
export function withArticle(concept: string): string {
  const l = labels(concept);
  if (l.pluralOnly) return l.en;
  return `${/^[aeiou]/i.test(l.en) ? 'an' : 'a'} ${l.en}`;
}

export type SizeHint = 'close' | 'far' | null;

export type ErrorKind =
  | 'network'
  | 'slow'
  | 'unauthorized'
  | 'notConfigured'
  | 'cantAnalyze'
  | 'server'
  | 'camera'
  /** The backend's daily spending limit for model calls is reached (HTTP 503 budget_exhausted). */
  | 'budget';

/** Mic indicator states (voice-session.ts micStatus). */
export type MicStatusLabel =
  | 'listening'
  | 'paused'
  | 'off'
  | 'asking'
  | 'needs-permission'
  | 'unavailable'
  | 'stopped';

export type Phrasebook = {
  start(concept: string): string;
  found(concept: string, position: Position, size: SizeHint): string;
  foundMany(concept: string, count: number, position: Position, size: SizeHint): string;
  guide(position: Position): string;
  lost(concept: string): string;
  coaching(concept: string, attempt: number): string;
  checkIn(concept: string): string;
  resume(concept: string): string;
  stop(): string;
  error(kind: ErrorKind): string;
  reconnected(): string;
  /** Replies to voice commands. */
  voice: {
    /** The one line that names the commands (the echo gate drops them while it plays). */
    help(): string;
    /** Listening gave up after errors; it retries on its own. */
    listeningLost(): string;
    notUnderstood(): string;
    paused(): string;
    nothingToPause(): string;
    nothingToResume(): string;
    nothingToRepeat(): string;
    cameraNotReady(): string;
  };
  ui: {
    status(status: SearchStatus): string;
    stopButton: string;
    /** VoiceOver hint for the End search button; it mentions the voice commands. */
    stopHint: string;
    /** The End button's hint while the search is paused. */
    pausedHint: string;
    mic: {
      /** Static text next to the mic button (not a live region: the app speaks for itself). */
      status: Record<MicStatusLabel, string>;
      turnOff: string;
      turnOffHint: string;
      turnOn: string;
      turnOnHint: string;
      allow: string;
      allowHint: string;
      openSettings: string;
      openSettingsHint: string;
    };
  };
};

const EN_WHERE: Record<Position, string> = {
  left: 'on the left',
  center: 'in the center',
  right: 'on the right',
};

const EN_SIZE: Record<'close' | 'far', string> = {
  close: 'It looks close.',
  far: 'It looks far away.',
};

const EN_TIPS = ['Try turning slowly.', 'Try tilting the phone up or down a little.'];

const en: Phrasebook = {
  start: (c) => `Looking for ${withArticle(c)}. Move your phone slowly.`,
  found: (c, p, size) =>
    `I found ${withArticle(c)}, ${EN_WHERE[p]} of the camera view.` + (size ? ` ${EN_SIZE[size]}` : ''),
  foundMany: (c, n, p, size) =>
    `I see ${n} ${labels(c).enPlural}. The largest is ${EN_WHERE[p]}.` +
    (size ? ` ${EN_SIZE[size]}` : ''),
  guide: (p) => (p === 'center' ? 'Centered.' : `Now ${EN_WHERE[p]}.`),
  lost: (c) => `I lost sight of the ${labels(c).en}. Still looking.`,
  coaching: (c, attempt) => `Still looking for ${withArticle(c)}. ${EN_TIPS[attempt % EN_TIPS.length]}`,
  // Was "... or tap Stop searching to end.": "stop searching" is a voice command.
  checkIn: (c) =>
    `I haven't found ${withArticle(c)} in the last minute. ` +
    'Keep moving the phone slowly, or tap End search to finish.',
  resume: (c) => `Looking for ${withArticle(c)} again.`,
  stop: () => 'Stopped searching.',
  // "HeyNavi server" became "the server": TTS must never say the wake word.
  error: (kind) =>
    ({
      network: "I can't reach the server. I'll keep trying.",
      slow: "The server is slow to answer. I'll keep trying.",
      unauthorized: "The server didn't accept this app. Check the app token.",
      notConfigured: "The server isn't set up yet. I'll keep trying.",
      cantAnalyze: "I can't analyze this view. Try pointing the camera somewhere else.",
      server: "The server had a problem. I'll keep trying.",
      camera: "I can't get a picture from the camera. I'll keep trying.",
      budget: "Today's limit for AI model calls is reached, so I can't look right now.",
    })[kind],
  reconnected: () => 'Connected again.',
  voice: {
    // No "stop" in it: the echo gate drops every word of this line while it plays, and the user
    // must be able to say "stop" over it.
    help: () =>
      "Say what's around me, or find and an object, like find a chair. Say quieter, or more detail. " +
      'Say pause, resume, or repeat. To end a search, say cancel.',
    listeningLost: () => "Voice commands stopped. I'll keep trying. The buttons still work.",
    notUnderstood: () => "Sorry, I didn't catch that. Say help to hear what I can do.",
    paused: () => 'Paused.',
    nothingToPause: () => 'No search is running.',
    nothingToResume: () => 'No search is paused.',
    nothingToRepeat: () => "I haven't said anything yet.",
    cameraNotReady: () => "The camera isn't ready yet.",
  },
  ui: {
    status: (s) =>
      ({
        IDLE: 'Ready',
        SEARCHING: 'Searching',
        CONFIRMING: 'Checking',
        FOUND: 'Found',
        GUIDING: 'Guiding',
        LOST: 'Lost',
        PAUSED: 'Paused',
        CANCELLED: 'Stopped',
      })[s],
    // Was "Stop searching": VoiceOver reads the label aloud and the microphone would hear a
    // cancel command.
    stopButton: 'End search',
    // "stop searching" always ends the search; a bare "stop" over HeyNavi's speech only silences it.
    stopHint: 'Ends the search. You can also say stop searching, or say pause.',
    pausedHint: 'Ends the search. To continue it, say resume.',
    mic: {
      status: {
        listening: 'Listening',
        paused: 'Paused',
        off: 'Mic off',
        asking: 'Asking for microphone access',
        'needs-permission': 'Needs microphone permission',
        unavailable: 'Voice commands unavailable',
        stopped: 'Mic stopped after errors',
      },
      turnOff: 'Turn listening off',
      turnOffHint: 'Stops listening for voice commands. Buttons keep working.',
      turnOn: 'Turn listening on',
      turnOnHint: 'Listens for voice commands again.',
      allow: 'Allow microphone',
      allowHint: 'Shows the iOS microphone and speech recognition prompt.',
      openSettings: 'Open Settings',
      openSettingsHint: "Opens this app's settings, where you can allow the microphone.",
    },
  },
};

export const PHRASES: Record<Lang, Phrasebook> = { 'en-US': en };

export function phrases(lang: Lang = 'en-US'): Phrasebook {
  return PHRASES[lang];
}
