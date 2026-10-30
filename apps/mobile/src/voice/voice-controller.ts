/**
 * The always-on listener without React: runs voice-session.ts effects against the recognizer,
 * keeps the stall watchdog, and turns transcripts into commands:
 *
 *   transcript -> command-grammar -> echo gate -> dedupe -> onCommand
 *
 * Interim results may only cut HeyNavi's speech off (a barge-in while it speaks runs as "quiet");
 * the final result decides everything else, including whether "stop" or "cancel" ends the
 * search. Over HeyNavi's speech the barge-in may follow its echoed words in the same segment
 * (echo-gate.ts bargeInTail), or come just before it (bargeInHead). The recognizer, clock, timers and speech state are injected, so all
 * of it runs under `node --test` with fakes. use-voice-commands.ts wires in
 * expo-speech-recognition.
 *
 * Transcript segments: on iOS 18+ a continuous session reports one segment at a time (interim
 * results, then a "final-like" result after a pause), and the next segment starts from scratch.
 * One spoken command is therefore one segment; it never acts twice (interim, then its final).
 */
import type { ExpoSpeechRecognitionErrorCode } from 'expo-speech-recognition';

import { acceptedOverSpeech, analyze, isBargeIn, sameCommand, type Analysis, type Command } from './command-grammar.ts';
import { ECHO, bargeInHead, bargeInTail, gate, inSpeechAt } from './echo-gate.ts';
import {
  VOICE,
  initialVoiceState,
  reduceVoice,
  type VoiceEffect,
  type VoiceEvent,
  type VoiceState,
} from './voice-session.ts';

/** Where a barge-in sat relative to HeyNavi's echoed words in the transcript, if any. */
type EchoSide = 'after' | 'before' | null;

export const LISTEN = {
  /** The same command again within this window is ignored. */
  debounceMs: 1500,
  /** How often the stall watchdog looks. */
  watchdogTickMs: 500,
  /** "Sorry, I didn't catch that" at most this often. */
  notUnderstoodMinIntervalMs: 4000,
  /**
   * A bare "stop" final this soon after an interim barge-in cut the speech is that same word.
   * iOS may reset the segment in between (a nomatch or an empty final), which loses the
   * "said over speech" fact; on the iPhone 16e the final then ended the search.
   */
  bargeInFollowMs: 2500,
} as const;

export type RecognizerPort = {
  /** Starts a session with the app's recognition options. */
  start(): void;
  abort(): void;
  requestPermissions(): Promise<{ granted: boolean; canAskAgain: boolean }>;
};

/** What the echo gate needs to know about HeyNavi's own speech (speech-tracker.ts). */
export type SpeechView = {
  readonly speaking: boolean;
  readonly currentText: string | null;
  readonly lastText: string | null;
  readonly lastEndedAt: number | null;
};

export type HeardCommand = {
  command: Command;
  transcript: string;
  isFinal: boolean;
  wake: boolean;
  /** When the result reached the app (same clock as `now`). */
  at: number;
  /**
   * HeyNavi was speaking (or had just stopped) when the segment's first result arrived: the
   * user spoke over it. Decides what "stop" means (voice-actions.ts).
   */
  speakingAtStart: boolean;
};

export type VoiceControllerDeps = {
  /** Null when the native module is missing (Expo Go): the session reports 'not-supported'. */
  recognizer: RecognizerPort | null;
  speech: SpeechView;
  now(): number;
  onCommand(heard: HeardCommand): void;
  /** Speech that started with "Hey Navi" but was not a command. */
  onNotUnderstood(transcript: string): void;
  /**
   * Listening stopped on its own (gave up after errors): say so once, since the mic label is
   * not a live region. Again only after a result has proved recognition works.
   */
  onListeningLost?(): void;
  log(line: string): void;
  /** Put transcripts in the log lines (development builds only: they are the user's words). */
  logTranscripts?: boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  setRepeatingTimer?: (fn: () => void, ms: number) => unknown;
  clearRepeatingTimer?: (handle: unknown) => void;
};

export type VoiceController = {
  /** Listening on (screen mount, or the user's mic toggle). */
  enable(): void;
  /** Listening off (the user's mic toggle). */
  disable(): void;
  setForeground(active: boolean): void;
  /** The app became active again, also after 'inactive' (Siri, a call): retry a dead listener. */
  retry(): void;
  setSpeaking(speaking: boolean): void;
  handleStart(): void;
  handleEnd(): void;
  handleError(code: ExpoSpeechRecognitionErrorCode, message: string): void;
  handleResult(isFinal: boolean, transcript: string): void;
  /** A segment ended without words (no "result" comes for it). */
  handleNoMatch(): void;
  handleVolume(): void;
  /** Unmount: stops listening. enable() works again afterwards. */
  shutdown(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): VoiceState;
};

export function createVoiceController(deps: VoiceControllerDeps): VoiceController {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const setRepeating = deps.setRepeatingTimer ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearRepeating =
    deps.clearRepeatingTimer ??
    ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  const listeners = new Set<() => void>();
  const quote = (transcript: string) => (deps.logTranscripts ? `: "${transcript}"` : '');

  let state: VoiceState = initialVoiceState();
  let restartTimer: unknown = null;
  let watchdog: unknown = null;
  /** Last start(), "start", volume or result event: the stall watchdog counts from here. */
  let lastActivityAt = deps.now();
  /** Commands already run for the current transcript segment, and when it began. */
  let segment: Command[] = [];
  let segmentStartedAt: number | null = null;
  /** HeyNavi was speaking when the current segment began. */
  let speakingAtStart = false;
  /** onListeningLost ran and no result has come since. */
  let lostReported = false;
  let lastRun: { command: Command; at: number } | null = null;
  /** When an interim barge-in last cut HeyNavi's speech off. */
  let lastBargeInAt = -Infinity;
  let lastNotUnderstoodAt = -Infinity;
  /** Bumped by shutdown, so a late permission answer is ignored. */
  let generation = 0;

  function publish() {
    for (const listener of listeners) listener();
  }

  function dispatch(event: VoiceEvent) {
    const previous = state;
    const { state: next, effects } = reduceVoice(state, event, deps.now());
    state = next;
    if (previous.status !== next.status || previous.error !== next.error) {
      deps.log(
        `[heynavi-voice] ${previous.status} -> ${next.status}${next.error ? ` (${next.error})` : ''} on ${event.type}`,
      );
    }
    run(effects);
    if (next.status === 'error' && next.error === 'gave-up' && previous.error !== 'gave-up' && !lostReported) {
      lostReported = true;
      deps.onListeningLost?.();
    }
    if (next !== previous) publish();
  }

  function run(effects: readonly VoiceEffect[]) {
    for (const effect of effects) {
      switch (effect.type) {
        case 'request-permission':
          requestPermission();
          break;
        case 'start':
          startNative();
          break;
        case 'abort':
          try {
            deps.recognizer?.abort();
          } catch (e) {
            deps.log(`[heynavi-voice] abort() threw: ${errorMessage(e)}`);
          }
          break;
        case 'schedule-restart':
          cancelRestart();
          restartTimer = setTimer(() => {
            restartTimer = null;
            dispatch({ type: 'restart-due' });
          }, effect.delayMs);
          break;
        case 'cancel-restart':
          cancelRestart();
          break;
      }
    }
  }

  function cancelRestart() {
    if (restartTimer != null) clearTimer(restartTimer);
    restartTimer = null;
  }

  function requestPermission() {
    const recognizer = deps.recognizer;
    if (!recognizer) return;
    const mine = generation;
    recognizer.requestPermissions().then(
      (result) => {
        if (mine === generation) {
          dispatch({ type: 'permission', granted: result.granted, canAskAgain: result.canAskAgain });
        }
      },
      (e: unknown) => {
        deps.log(`[heynavi-voice] permission request failed: ${errorMessage(e)}`);
        if (mine === generation) dispatch({ type: 'permission-failed' });
      },
    );
  }

  function endSegment() {
    segment = [];
    segmentStartedAt = null;
    speakingAtStart = false;
  }

  function startNative() {
    lastActivityAt = deps.now();
    endSegment();
    try {
      deps.recognizer?.start();
    } catch (e) {
      deps.log(`[heynavi-voice] start() threw: ${errorMessage(e)}`);
      // Not inside this dispatch: the reducer must see the "starting" state first.
      setTimer(() => dispatch({ type: 'start-failed' }), 0);
    }
  }

  function ensureWatchdog() {
    if (watchdog != null) return;
    watchdog = setRepeating(() => {
      const running = state.status === 'starting' || state.status === 'listening';
      if (!running || !state.native) return;
      // Speech re-arms it: the 3 s window starts again once HeyNavi stops talking.
      if (state.speaking) {
        lastActivityAt = deps.now();
        return;
      }
      if (deps.now() - lastActivityAt >= VOICE.stallMs) {
        deps.log(`[heynavi-voice] no audio events for ${VOICE.stallMs} ms: restarting`);
        lastActivityAt = deps.now();
        dispatch({ type: 'stall' });
      }
    }, LISTEN.watchdogTickMs);
  }

  function stopWatchdog() {
    if (watchdog != null) clearRepeating(watchdog);
    watchdog = null;
  }

  /**
   * Echo gate (skipped for a barge-in found before or after the echo: matching already told the
   * user's words from HeyNavi's) + dedupe. `run` is what actually runs: "quiet" for an interim barge-in.
   */
  function act(
    command: Command,
    heard: { transcript: string; isFinal: boolean; wake: boolean; at: number; echo: EchoSide },
    run: Command = command,
  ): boolean {
    const { speech } = deps;
    const { transcript, isFinal, wake, at } = heard;
    const verdict = heard.echo
      ? ({ allow: true } as const)
      : gate({
          transcript,
          command,
          wake,
          isFinal,
          speaking: speech.speaking,
          currentUtterance: speech.currentText,
          lastUtterance: speech.lastText,
          lastSpeechEndedAt: speech.lastEndedAt,
          segmentStartedAt,
          speakingAtSegmentStart: speakingAtStart,
          now: at,
        });
    if (!verdict.allow) {
      deps.log(`[heynavi-voice] dropped ${command.type} (${verdict.reason})${quote(transcript)}`);
      return false;
    }
    if (segment.some((done) => covers(done, run, speakingAtStart))) return false;
    if (lastRun && sameCommand(lastRun.command, run) && at - lastRun.at < LISTEN.debounceMs) {
      return false;
    }
    // Only after a reset (empty segment): otherwise `covers` above already decided with the
    // segment's own speakingAtStart.
    if (isFinal && run.type === 'stop' && segment.length === 0 && at - lastBargeInAt < LISTEN.bargeInFollowMs) {
      deps.log(`[heynavi-voice] final stop covered by the barge-in ${Math.round(at - lastBargeInAt)} ms earlier`);
      return false;
    }
    if (!isFinal) lastBargeInAt = at;
    segment.push(run);
    lastRun = { command: run, at };
    const label = (run === command ? run.type : `${command.type} as ${run.type}`) + (heard.echo ? ` (${heard.echo} echo)` : '');
    deps.log(`[heynavi-voice] ${isFinal ? 'final' : 'interim'} -> ${label}${quote(transcript)}`);
    deps.onCommand({ command: run, transcript, isFinal, wake, at, speakingAtStart });
    return true;
  }

  /** HeyNavi's speech may be in this segment's transcript. */
  function overlapsSpeech(): boolean {
    const { speech } = deps;
    if (speech.speaking || speakingAtStart) return true;
    return speech.lastEndedAt != null && segmentStartedAt != null && speech.lastEndedAt >= segmentStartedAt;
  }

  /** The utterances whose echo may be in this segment, oldest first. */
  function echoReferences(): string[] {
    const { speech } = deps;
    const references: string[] = [];
    const lastOverlaps =
      speech.lastEndedAt != null && segmentStartedAt != null && speech.lastEndedAt >= segmentStartedAt - ECHO.tailMs;
    if (speech.lastText && lastOverlaps) references.push(speech.lastText);
    if (speech.currentText) references.push(speech.currentText);
    return references;
  }

  /** The whole transcript as a command, or over HeyNavi's speech a barge-in after or before its echo. */
  function understand(transcript: string): { analysis: Analysis; echo: EchoSide } {
    const analysis = analyze(transcript);
    if (!overlapsSpeech()) return { analysis, echo: null };
    const references = echoReferences();
    const wholeIsCommand = analysis.command != null && acceptedOverSpeech(analysis.command);
    if (!wholeIsCommand) {
      const tail = bargeInTail(transcript, references);
      if (tail) return { analysis: tail.analysis, echo: 'after' };
    }
    // Also for a whole-transcript barge-in: "stop" + "looking for a chair ..." reads as "stop
    // looking for" (cancel), which the gate then drops as HeyNavi's own words.
    const head = bargeInHead(transcript, references);
    return head ? { analysis: head.analysis, echo: 'before' } : { analysis, echo: null };
  }

  function onTranscript(isFinal: boolean, transcript: string) {
    const at = deps.now();
    if (segmentStartedAt == null) {
      segmentStartedAt = at;
      speakingAtStart = inSpeechAt(deps.speech.speaking, deps.speech.lastEndedAt, at);
    }
    const { analysis, echo } = understand(transcript);
    const { command, wake } = analysis;
    const heard = { transcript, isFinal, wake, at, echo };
    if (!isFinal) {
      // Only cuts the speech off; the final decides about the search.
      if (command && actsOnInterim(command, deps.speech.speaking)) act(command, heard, { type: 'quiet' });
      return;
    }
    try {
      if (command) {
        act(command, heard);
      } else {
        // Dev builds only (transcripts): shows what a command that "did nothing" was heard as.
        if (deps.logTranscripts) deps.log(`[heynavi-voice] final, no command${quote(transcript)}`);
        if (wake && analysis.text.length > 0 && segment.length === 0) notUnderstood(transcript, at);
      }
    } finally {
      endSegment();
    }
  }

  function notUnderstood(transcript: string, at: number) {
    const { speech } = deps;
    // Gated like a command: while HeyNavi speaks it is most likely an echo.
    const verdict = gate({
      transcript,
      command: null,
      wake: true,
      isFinal: true,
      speaking: speech.speaking,
      currentUtterance: speech.currentText,
      lastUtterance: speech.lastText,
      lastSpeechEndedAt: speech.lastEndedAt,
      segmentStartedAt,
      speakingAtSegmentStart: speakingAtStart,
      now: at,
    });
    if (!verdict.allow || at - lastNotUnderstoodAt < LISTEN.notUnderstoodMinIntervalMs) return;
    lastNotUnderstoodAt = at;
    deps.onNotUnderstood(transcript);
  }

  return {
    enable() {
      ensureWatchdog();
      // The user acted: if this attempt fails too, say so again.
      lostReported = false;
      if (!deps.recognizer) {
        dispatch({ type: 'enable' });
        dispatch({ type: 'unsupported' });
        return;
      }
      dispatch({ type: 'enable' });
    },
    disable() {
      dispatch({ type: 'disable' });
    },
    setForeground(active) {
      if (active) lastActivityAt = deps.now();
      dispatch({ type: 'app-state', active });
    },
    retry() {
      lastActivityAt = deps.now();
      dispatch({ type: 'retry' });
    },
    setSpeaking(speaking) {
      if (!speaking) lastActivityAt = deps.now();
      dispatch({ type: 'tts', speaking });
    },
    handleStart() {
      lastActivityAt = deps.now();
      dispatch({ type: 'native-start' });
    },
    handleEnd() {
      endSegment();
      dispatch({ type: 'native-end' });
    },
    handleError(code, message) {
      deps.log(`[heynavi-voice] recognizer error ${code}: ${message}`);
      dispatch({ type: 'native-error', code });
    },
    handleResult(isFinal, transcript) {
      lastActivityAt = deps.now();
      lostReported = false;
      dispatch({ type: 'result' });
      // Results that arrive after a pause or stop are not acted on.
      if (state.status !== 'listening' && state.status !== 'starting') return;
      if (transcript.trim().length === 0) {
        if (isFinal) {
          if (segmentStartedAt != null) deps.log('[heynavi-voice] empty final: segment reset');
          endSegment();
        }
        return;
      }
      onTranscript(isFinal, transcript);
    },
    handleNoMatch() {
      lastActivityAt = deps.now();
      if (segmentStartedAt != null) deps.log('[heynavi-voice] nomatch: segment reset');
      // Otherwise the next segment would inherit this one's start time and commands.
      endSegment();
    },
    handleVolume() {
      lastActivityAt = deps.now();
    },
    shutdown() {
      generation++;
      dispatch({ type: 'shutdown' });
      cancelRestart();
      stopWatchdog();
      endSegment();
      lastRun = null;
      lastBargeInAt = -Infinity;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return state;
    },
  };
}

/**
 * Whether an interim result acts at once. Only a barge-in, and only while HeyNavi speaks: it then
 * cuts the speech off (run as "quiet"). Everything else waits for the final, which shows whether
 * the sentence was a command at all: "stop looking at me" and "never mind, find the door
 * instead" begin like one, and stopping the search by mistake is worse than a short wait.
 */
export function actsOnInterim(command: Command, speaking: boolean): boolean {
  return speaking && isBargeIn(command);
}

/**
 * True when `done` (already run for this segment) makes `next` pointless. `stopMeansSilence`:
 * the segment began over HeyNavi's speech, so "stop" means "stop talking" (voice-actions.ts). An
 * early cut-off does not cover a final that ends the search ("stop searching", or "stop" said in
 * silence).
 */
export function covers(done: Command, next: Command, stopMeansSilence = true): boolean {
  if (sameCommand(done, next)) return true;
  const silences = (c: Command) => c.type === 'quiet' || (c.type === 'stop' && stopMeansSilence);
  if (done.type === 'cancel') return next.type === 'stop' || next.type === 'quiet';
  if (silences(done)) return silences(next);
  return false;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
