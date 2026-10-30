/**
 * Echo gate (ARCHITECTURE 9): the microphone hears HeyNavi's own speech through the loudspeaker,
 * so every transcript passes here before it may act. Pure, so it runs under `node --test`.
 *
 * Rules, in order:
 * 1. Self-transcription: a transcript whose content words mostly (>= 60%) appear in the current
 *    or last utterance is dropped when its segment began while HeyNavi was speaking (or within
 *    the tail). Finals arrive after the recognizer's end-of-speech delay, so "when it arrived"
 *    is the wrong test: an echo of the help line's "pause" can arrive 600 ms after it ended,
 *    while the user's "help" in reply to "Say help ..." starts after it. Without a segment
 *    start time, the check covers `selfEchoWindowMs` after the speech.
 * 2. While speaking, and for `tailMs` after, only barge-in commands (stop / cancel / quiet) pass,
 *    and not one whose words are all in the utterance being spoken ("Stopped searching." must
 *    not cancel). A command that starts with the wake phrase also passes ("Hey Navi, find a
 *    cup"): no HeyNavi phrase contains the wake word, which phrases.test.ts enforces.
 *    "While speaking" is judged when the segment began, not when its final arrived: the final
 *    comes about a second after the user stopped talking, and a guidance line may start in
 *    between.
 *
 * Barge-in over an echo (bargeInTail): when the recognizer also writes down the loudspeaker, the
 * user's "stop" lands in the same segment as HeyNavi's words ("I found a chair on the left
 * stop"), so the whole transcript is no command. The words that follow the part matching
 * HeyNavi's speech in order are the user's, and may be a barge-in command.
 */
import { acceptedOverSpeech, analyze, normalize, stripWake, type Analysis, type Command } from './command-grammar.ts';

export const ECHO = {
  /** After TTS ends, transcripts are still treated as overlapping speech for this long. */
  tailMs: 400,
  /** Self-transcription window after TTS ends, used when the segment start is unknown. */
  selfEchoWindowMs: 1500,
  /** Fraction of a transcript's content words found in the utterance that marks it an echo. */
  overlap: 0.6,
} as const;

export type EchoInput = {
  transcript: string;
  /** What command-grammar made of the transcript (null: not a command). */
  command: Command | null;
  /** The transcript started with the wake phrase. */
  wake: boolean;
  isFinal: boolean;
  /** TTS is speaking now (from speak() until the speaker reports done or stopped). */
  speaking: boolean;
  /** Text being spoken now, if any. */
  currentUtterance: string | null;
  /** Text of the utterance that ended most recently. */
  lastUtterance: string | null;
  /** When the last utterance ended (same clock as `now`). */
  lastSpeechEndedAt: number | null;
  /** When the first result of this transcript segment arrived (null: unknown). */
  segmentStartedAt?: number | null;
  /**
   * HeyNavi was speaking (or within `tailMs` of it) when the segment's first result arrived.
   * Rule 2 uses it; without it, rule 2 looks at the speech state now.
   */
  speakingAtSegmentStart?: boolean;
  now: number;
};

export type EchoVerdict =
  | { allow: true }
  | { allow: false; reason: 'self-echo' | 'speaking' | 'own-words' };

/** Function words that say nothing about whether a transcript is an echo. */
const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'on',
  'in',
  'to',
  'is',
  'it',
  'i',
  'you',
  'your',
  'my',
  'me',
  'and',
  'or',
  'for',
  'at',
  'this',
  'that',
  'be',
  'with',
  'now',
  'please',
]);

/**
 * Crude suffix stemmer, applied to both sides: "stopped"/"stop", "searching"/"search",
 * "paused"/"pause", "chairs"/"chair". Only equality of stems matters, never the stem itself.
 */
export function stem(word: string): string {
  let w = word.replace(/'s$/, '').replace(/'/g, '');
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 3) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  if (/([b-df-hj-np-tv-z])\1$/.test(w)) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** Content-word stems of a text. "HeyNavi" counts as "hey navi", as the recognizer writes it. */
export function contentStems(text: string): string[] {
  const words = normalize(text.replace(/heynavi/gi, 'hey navi')).split(' ');
  return words.filter((w) => w.length > 0 && !STOPWORDS.has(w)).map(stem);
}

/** Share of `transcript`'s content words that also occur in one of the reference texts. */
export function overlapRatio(transcript: string, references: readonly string[]): number {
  const words = contentStems(transcript);
  if (words.length === 0 || references.length === 0) return 0;
  const known = new Set(references.flatMap(contentStems));
  return words.filter((w) => known.has(w)).length / words.length;
}

/** HeyNavi is speaking at `at`, or stopped less than `tailMs` before it. */
export function inSpeechAt(speaking: boolean, lastSpeechEndedAt: number | null, at: number): boolean {
  return speaking || (lastSpeechEndedAt != null && at - lastSpeechEndedAt < ECHO.tailMs);
}

export function gate(input: EchoInput): EchoVerdict {
  const { speaking, lastSpeechEndedAt, now } = input;
  const sinceEnd = (t: number) => (lastSpeechEndedAt == null ? Infinity : t - lastSpeechEndedAt);
  const inSpeech = input.speakingAtSegmentStart ?? inSpeechAt(speaking, lastSpeechEndedAt, now);
  const startedAt = input.segmentStartedAt;
  const overlapped =
    speaking ||
    (startedAt != null ? sinceEnd(Math.min(startedAt, now)) < ECHO.tailMs : sinceEnd(now) < ECHO.selfEchoWindowMs);

  // The wake phrase never comes from TTS, so compare only what follows it.
  const spoken = stripWake(normalize(input.transcript)).rest;

  if (overlapped) {
    const references = [input.currentUtterance, input.lastUtterance].filter(
      (t): t is string => t != null && t.length > 0,
    );
    if (overlapRatio(spoken, references) >= ECHO.overlap) return { allow: false, reason: 'self-echo' };
  }

  if (!inSpeech) return { allow: true };

  const { command } = input;
  if (command && acceptedOverSpeech(command)) {
    const utterance = input.currentUtterance ?? input.lastUtterance;
    if (utterance && allWordsIn(spoken, utterance)) return { allow: false, reason: 'own-words' };
    return { allow: true };
  }
  if (command && input.wake) return { allow: true };
  return { allow: false, reason: 'speaking' };
}

function allWordsIn(transcript: string, utterance: string): boolean {
  const words = contentStems(transcript);
  if (words.length === 0) return false;
  const known = new Set(contentStems(utterance));
  return words.every((w) => known.has(w));
}

/** Once aligned, an echoed word may skip at most this many words the recognizer dropped. */
const ALIGN_WINDOW = 4;
/** Misheard words allowed between the echo and the user's command ("... camera few stop"). */
const MAX_TAIL_STRAYS = 2;
/** Longest command looked for in a tail ("hey navi where is the front door"). */
const MAX_TAIL_COMMAND_WORDS = 8;

export type EchoAlignment = {
  /** Normalized words after the last one that matched HeyNavi's speech. */
  tail: string[];
  /** HeyNavi's words after the matched part (not echoed yet: they may still come back). */
  ahead: string[];
};

/**
 * Matches the transcript's words, in order, against HeyNavi's speech (stems, so "stopped" is
 * "stop"). The first match may be anywhere (a segment can start mid-sentence); after that each
 * match must follow the previous one within ALIGN_WINDOW words. A word that matches nothing is
 * skipped (misheard). Null when no word matches: there is no echo in the transcript.
 *
 * A line can repeat a word ("or" twice in the help line), so every place the first matched word
 * occurs is tried as the start, and the start that explains the most words wins.
 */
export function alignEcho(transcript: string, references: readonly string[]): EchoAlignment | null {
  const words = normalize(transcript).split(' ').filter((w) => w.length > 0);
  const ref = references.flatMap((r) =>
    normalize(r.replace(/heynavi/gi, 'hey navi'))
      .split(' ')
      .filter((w) => w.length > 0),
  );
  const refStems = ref.map(stem);
  const first = words.findIndex((w) => refStems.includes(stem(w)));
  if (first < 0) return null;
  let best: { pos: number; last: number; matched: number } | null = null;
  refStems.forEach((refStem, start) => {
    if (refStem !== stem(words[first])) return;
    let pos = start + 1;
    let last = first;
    let matched = 1;
    for (let i = first + 1; i < words.length; i++) {
      const target = stem(words[i]);
      const end = Math.min(ref.length, pos + ALIGN_WINDOW);
      for (let j = pos; j < end; j++) {
        if (refStems[j] === target) {
          pos = j + 1;
          last = i;
          matched++;
          break;
        }
      }
    }
    if (!best || matched > best.matched || (matched === best.matched && last > best.last)) {
      best = { pos, last, matched };
    }
  });
  const { pos, last } = best!;
  return { tail: words.slice(last + 1), ahead: ref.slice(pos) };
}

/**
 * A command said after HeyNavi's own words in one segment, or null: a barge-in, or another
 * command accepted over speech (acceptedOverSpeech). Tries the longest
 * ending of the tail first, allowing a couple of misheard words before it. A command whose words
 * HeyNavi has yet to say is not trusted: it may be the echo running ahead of the alignment.
 */
export function bargeInTail(
  transcript: string,
  references: readonly string[],
): { text: string; analysis: Analysis } | null {
  const aligned = alignEcho(transcript, references);
  if (!aligned || aligned.tail.length === 0) return null;
  const { tail, ahead } = aligned;
  // A fixed command first; a free-form question only when none fits.
  for (const allowQuestion of [false, true]) {
    for (let strays = 0; strays <= Math.min(MAX_TAIL_STRAYS, tail.length - 1); strays++) {
      const words = tail.slice(strays);
      if (words.length > MAX_TAIL_COMMAND_WORDS) continue;
      const text = words.join(' ');
      const analysis = analyze(text);
      if (!analysis.command || !acceptedOverSpeech(analysis.command)) continue;
      if ((analysis.command.type === 'ask') !== allowQuestion) continue;
      if (ahead.length > 0 && allWordsIn(stripWake(text).rest, ahead.join(' '))) return null;
      return { text, analysis };
    }
  }
  return questionTail(transcript, references);
}

/**
 * A question at the end of a segment that alignment missed: its own small words ("is", "the") can
 * align with HeyNavi's line and cut the question in half. The mirror of bargeInHead: the longest
 * ending that is a question, with no content word of HeyNavi's, after mostly HeyNavi's words.
 */
function questionTail(transcript: string, references: readonly string[]): { text: string; analysis: Analysis } | null {
  const words = normalize(transcript).split(' ').filter((w) => w.length > 0);
  const known = new Set(references.flatMap(contentStems));
  for (let n = Math.min(MAX_TAIL_COMMAND_WORDS, words.length - 1); n >= 2; n--) {
    const text = words.slice(words.length - n).join(' ');
    const analysis = analyze(text);
    if (analysis.command?.type !== 'ask') continue;
    if (contentStems(stripWake(text).rest).some((w) => known.has(w))) continue;
    if (overlapRatio(words.slice(0, words.length - n).join(' '), references) < ECHO.overlap) continue;
    return { text, analysis };
  }
  return null;
}

/** Longest command looked for at the start of a segment ("what objects are nearby", "hey navi where is the door"). */
const MAX_HEAD_COMMAND_WORDS = 8;

/**
 * A command accepted over speech, said just before HeyNavi's words came back in the same segment ("cancel the largest
 * is on the left"), or null. What follows must be mostly HeyNavi's words, and no content word of
 * the command may be one: "Stopped searching." comes back as "stop searching", which is the echo
 * itself, and in "stop looking for a chair ..." the "looking for" is HeyNavi's, so only "stop"
 * was the user's.
 */
export function bargeInHead(
  transcript: string,
  references: readonly string[],
): { text: string; analysis: Analysis } | null {
  const words = normalize(transcript).split(' ').filter((w) => w.length > 0);
  const known = new Set(references.flatMap(contentStems));
  // A fixed command first ("what's around me" before "what's around me a"); a free-form question
  // only when none fits, then the longest one that is not HeyNavi's own words.
  for (const allowQuestion of [false, true]) {
    for (let n = Math.min(MAX_HEAD_COMMAND_WORDS, words.length - 1); n >= 1; n--) {
      const text = words.slice(0, n).join(' ');
      const analysis = analyze(text);
      if (!analysis.command || !acceptedOverSpeech(analysis.command)) continue;
      if ((analysis.command.type === 'ask') !== allowQuestion) continue;
      if (contentStems(stripWake(text).rest).some((w) => known.has(w))) continue;
      if (overlapRatio(words.slice(n).join(' '), references) < ECHO.overlap) continue;
      return { text, analysis };
    }
  }
  return null;
}
