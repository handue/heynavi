import {
  AVAudioSessionCategory,
  AVAudioSessionCategoryOptions,
  AVAudioSessionMode,
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
  type ExpoSpeechRecognitionErrorCode,
  type ExpoSpeechRecognitionOptions,
} from 'expo-speech-recognition';
import { useEffect, useRef, useState } from 'react';

import type {
  SpeechRecognitionReport,
  SttLocaleReport,
  SttStreakError,
} from '@/diagnostics/report';
import {
  MAX_ERROR_STREAK,
  isSelfInflictedAbort,
  nextErrorStreak,
  restartDelayMs,
} from '@/diagnostics/stt-restart';
import { formatClock, round } from '@/lib/stats';

/** English only for the hackathon MVP. */
export type SttLocale = 'en-US';

export type LogEntry = { id: number; clock: string; sinceStartMs: number | null; text: string };
export type FinalSegment = { id: number; clock: string; locale: SttLocale; text: string };

type PermissionResult = Awaited<ReturnType<typeof ExpoSpeechRecognitionModule.getPermissionsAsync>>;

const MAX_LOG = 50;
const MAX_KEPT = 10;

const CONTEXTUAL_STRINGS: Record<SttLocale, string[]> = {
  'en-US': ['Hey Navi', 'Navi', 'stop', 'repeat', 'find', 'pause', 'resume'],
};

/** Restarting after these would just fail again in a tight loop. */
const FATAL_ERRORS: readonly ExpoSpeechRecognitionErrorCode[] = [
  'not-allowed',
  'service-not-allowed',
  'language-not-supported',
  'aborted',
];

function recognitionOptions(lang: SttLocale): ExpoSpeechRecognitionOptions {
  return {
    lang,
    continuous: true,
    interimResults: true,
    // Falls back to network recognition SILENTLY if the locale has no on-device model.
    requiresOnDeviceRecognition: true,
    addsPunctuation: true,
    contextualStrings: CONTEXTUAL_STRINGS[lang],
    // The library's default iOS mode, "measurement", lowers TTS playback volume.
    iosCategory: {
      category: AVAudioSessionCategory.playAndRecord,
      categoryOptions: [
        AVAudioSessionCategoryOptions.defaultToSpeaker,
        AVAudioSessionCategoryOptions.allowBluetooth,
      ],
      mode: AVAudioSessionMode.default,
    },
  };
}

function emptyLocaleReport(): SttLocaleReport {
  return {
    sessions: 0,
    autoRestarts: 0,
    inSupportedLocales: null,
    firstResultLatencyMs: null,
    finalSegments: [],
    errors: [],
  };
}

function describePermission(p: PermissionResult): string {
  return p.restricted ? `${p.status} (restricted)` : p.status;
}

function safeSync<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

export function useSpeechRecognitionTest() {
  const [locale, setLocale] = useState<SttLocale>('en-US');
  const [permission, setPermission] = useState<string | null>(null);
  const [supportedLocales, setSupportedLocales] = useState<string[] | null>(null);
  // Checked once: on iOS this only reflects the DEVICE DEFAULT locale, not `locale`.
  const [onDeviceDefault] = useState(() =>
    safeSync(() => ExpoSpeechRecognitionModule.supportsOnDeviceRecognition()),
  );
  const [recognitionAvailable] = useState(() =>
    safeSync(() => ExpoSpeechRecognitionModule.isRecognitionAvailable()),
  );
  const [active, setActive] = useState(false);
  const [interim, setInterim] = useState('');
  const [finals, setFinals] = useState<FinalSegment[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [autoRestart, setAutoRestart] = useState(false);
  const [restartCount, setRestartCount] = useState(0);
  const [firstStreakError, setFirstStreakError] = useState<SttStreakError | null>(null);
  const [stoppedAfterErrors, setStoppedAfterErrors] = useState<number | null>(null);
  const [perLocale, setPerLocale] = useState<Record<SttLocale, SttLocaleReport>>({
    'en-US': emptyLocaleReport(),
  });

  const activeRef = useRef(false);
  const userStoppedRef = useRef(false);
  const sessionLocaleRef = useRef<SttLocale>('en-US');
  const pressedStartAtRef = useRef<number | null>(null);
  const sessionStartAtRef = useRef(0);
  const awaitingFirstResultRef = useRef(false);
  const lastErrorRef = useRef<ExpoSpeechRecognitionErrorCode | null>(null);
  const sessionFirstErrorRef = useRef<SttStreakError | null>(null);
  const sessionHadResultRef = useRef(false);
  /** Sessions in a row that ended with an error and no result. */
  const errorStreakRef = useRef(0);
  /** Auto-restarts since the last result; drives the backoff. */
  const restartAttemptRef = useRef(0);
  /** Set when WE call abort(), so its "aborted" error is not reported as a failure. */
  const abortRequestedRef = useRef(false);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextIdRef = useRef(1);

  useEffect(() => {
    let cancelled = false;
    ExpoSpeechRecognitionModule.getPermissionsAsync()
      .then((p) => !cancelled && setPermission(describePermission(p)))
      .catch(() => {});
    ExpoSpeechRecognitionModule.getSupportedLocales({})
      .then((r) => !cancelled && setSupportedLocales(r.locales))
      .catch(() => !cancelled && setSupportedLocales([]));
    return () => {
      cancelled = true;
      userStoppedRef.current = true;
      abortRequestedRef.current = true;
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      if (activeRef.current) ExpoSpeechRecognitionModule.abort();
    };
  }, []);

  function markActive(value: boolean) {
    activeRef.current = value;
    setActive(value);
  }

  function addLog(text: string) {
    const now = performance.now();
    const pressedAt = pressedStartAtRef.current;
    const entry: LogEntry = {
      id: nextIdRef.current++,
      clock: formatClock(new Date()),
      sinceStartMs: pressedAt == null ? null : round(now - pressedAt),
      text,
    };
    setLog((prev) => [entry, ...prev].slice(0, MAX_LOG));
  }

  function updateLocale(lang: SttLocale, fn: (r: SttLocaleReport) => SttLocaleReport) {
    setPerLocale((prev) => ({ ...prev, [lang]: fn(prev[lang]) }));
  }

  function beginSession(lang: SttLocale, isRestart: boolean) {
    sessionLocaleRef.current = lang;
    sessionStartAtRef.current = performance.now();
    awaitingFirstResultRef.current = true;
    lastErrorRef.current = null;
    sessionFirstErrorRef.current = null;
    sessionHadResultRef.current = false;
    updateLocale(lang, (r) => ({
      ...r,
      sessions: r.sessions + 1,
      autoRestarts: r.autoRestarts + (isRestart ? 1 : 0),
      inSupportedLocales: supportedLocales ? supportedLocales.includes(lang) : null,
    }));
    markActive(true);
    ExpoSpeechRecognitionModule.start(recognitionOptions(lang));
  }

  async function start() {
    if (activeRef.current) return;
    markActive(true); // Blocks a double tap while the permission prompt is up.
    userStoppedRef.current = false;
    abortRequestedRef.current = false;
    errorStreakRef.current = 0;
    restartAttemptRef.current = 0;
    setStoppedAfterErrors(null);
    pressedStartAtRef.current = performance.now();
    const result = await ExpoSpeechRecognitionModule.requestPermissionsAsync().catch(() => null);
    if (result) setPermission(describePermission(result));
    if (!result?.granted || userStoppedRef.current) {
      markActive(false);
      addLog(
        result?.granted
          ? 'stopped before start'
          : `permission ${result?.status ?? 'request failed'}: not starting`,
      );
      return;
    }
    addLog(`start() ${locale}`);
    beginSession(locale, false);
  }

  /** Stop: finish and deliver the final result. Abort: drop everything now. */
  function stopOrAbort(kind: 'stop' | 'abort') {
    userStoppedRef.current = true;
    if (kind === 'abort') abortRequestedRef.current = true;
    if (restartTimerRef.current) {
      // Between an "end" and the scheduled restart: nothing is running natively.
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
      markActive(false);
      addLog(`${kind}() cancelled the pending restart`);
      return;
    }
    if (!activeRef.current) return;
    addLog(`${kind}()`);
    if (kind === 'stop') ExpoSpeechRecognitionModule.stop();
    else ExpoSpeechRecognitionModule.abort();
  }

  useSpeechRecognitionEvent('start', () => addLog('event start'));
  useSpeechRecognitionEvent('audiostart', () => addLog('event audiostart'));
  useSpeechRecognitionEvent('audioend', () => addLog('event audioend'));
  useSpeechRecognitionEvent('nomatch', () => addLog('event nomatch'));

  useSpeechRecognitionEvent('result', (event) => {
    const lang = sessionLocaleRef.current;
    // Any result proves recognition works: end the error streak and the backoff.
    sessionHadResultRef.current = true;
    errorStreakRef.current = 0;
    restartAttemptRef.current = 0;
    const transcript = event.results[0]?.transcript ?? '';
    if (awaitingFirstResultRef.current) {
      awaitingFirstResultRef.current = false;
      const latency = round(performance.now() - sessionStartAtRef.current);
      updateLocale(lang, (r) => ({ ...r, firstResultLatencyMs: r.firstResultLatencyMs ?? latency }));
      addLog(`first result after ${latency} ms`);
    }
    if (!event.isFinal) {
      setInterim(transcript);
      return;
    }
    setInterim('');
    if (!transcript) return;
    const segment: FinalSegment = {
      id: nextIdRef.current++,
      clock: formatClock(new Date()),
      locale: lang,
      text: transcript,
    };
    setFinals((prev) => [segment, ...prev].slice(0, MAX_LOG));
    updateLocale(lang, (r) => ({
      ...r,
      finalSegments: [...r.finalSegments, transcript].slice(-MAX_KEPT),
    }));
  });

  useSpeechRecognitionEvent('error', (event) => {
    const code = event.code == null ? '' : ` (code ${event.code})`;
    if (isSelfInflictedAbort(event.error, abortRequestedRef.current)) {
      addLog(`event error ${event.error}${code} after abort(): not counted as an error`);
      return;
    }
    lastErrorRef.current = event.error;
    const text = `${event.error}: ${event.message}`;
    sessionFirstErrorRef.current ??= {
      clock: formatClock(new Date()),
      locale: sessionLocaleRef.current,
      error: text,
    };
    addLog(`event error ${event.error}${code}: ${event.message}`);
    updateLocale(sessionLocaleRef.current, (r) => ({
      ...r,
      errors: [...r.errors, text].slice(-MAX_KEPT),
    }));
  });

  useSpeechRecognitionEvent('end', () => {
    addLog('event end');
    setInterim('');
    const lastError = lastErrorRef.current;
    const previousStreak = errorStreakRef.current;
    const streak = nextErrorStreak(previousStreak, {
      hadResult: sessionHadResultRef.current,
      error: lastError,
    });
    errorStreakRef.current = streak;
    // Kept outside the capped log so a long streak cannot push its cause out.
    if (previousStreak === 0 && streak > 0) setFirstStreakError(sessionFirstErrorRef.current);
    const shouldRestart =
      autoRestart &&
      !userStoppedRef.current &&
      !(lastError && FATAL_ERRORS.includes(lastError));
    if (!shouldRestart) {
      markActive(false);
      return;
    }
    if (streak >= MAX_ERROR_STREAK) {
      addLog(`auto-restart stopped after ${streak} errors`);
      setStoppedAfterErrors(streak);
      markActive(false);
      return;
    }
    const delay = restartDelayMs(restartAttemptRef.current, lastError);
    restartAttemptRef.current++;
    // Keep `active` true through the gap so Stop and Abort stay available.
    restartTimerRef.current = setTimeout(() => {
      restartTimerRef.current = null;
      if (userStoppedRef.current) return;
      setRestartCount((n) => n + 1);
      addLog(`auto-restart ${sessionLocaleRef.current} after ${delay} ms`);
      beginSession(sessionLocaleRef.current, true);
    }, delay);
  });

  const report: SpeechRecognitionReport = {
    available: true,
    permission,
    onDeviceForDefaultLocale: onDeviceDefault,
    requiresOnDeviceRecognition: true,
    airplaneModeVerified: 'not recorded by the app; tester must confirm',
    firstStreakError,
    autoRestartStoppedAfterErrors: stoppedAfterErrors,
    locales: Object.fromEntries(
      (Object.keys(perLocale) as SttLocale[])
        .filter((lang) => perLocale[lang].sessions > 0)
        .map((lang) => [lang, perLocale[lang]]),
    ),
  };

  return {
    locale,
    setLocale,
    permission,
    localeSupported: supportedLocales ? supportedLocales.includes(locale) : null,
    onDeviceDefault,
    recognitionAvailable,
    active,
    interim,
    finals,
    log,
    autoRestart,
    setAutoRestart,
    restartCount,
    firstStreakError,
    stoppedAfterErrors,
    start,
    stop: () => stopOrAbort('stop'),
    abort: () => stopOrAbort('abort'),
    report,
  };
}
