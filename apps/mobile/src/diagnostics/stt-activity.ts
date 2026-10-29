/** Was speech recognition running during a capture run? Pure, so it runs under `node --test`. */

/** getStateAsync(): "starting", "recognizing" and "stopping" all hold the microphone. */
export function isRecognizerActive(state: string): boolean {
  return state !== 'inactive';
}

/**
 * Folds one sample into the run's answer: true once any sample was active, false when samples
 * were read and none was active, null while nothing could be read (sample null = unknown).
 */
export function mergeActivity(previous: boolean | null, sample: boolean | null): boolean | null {
  if (previous === true || sample === true) return true;
  return sample ?? previous;
}
