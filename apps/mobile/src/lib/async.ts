/** Pure async helpers. No React Native imports, so they run under `node --test`. */

/**
 * Settles with `promise`, or rejects as soon as `signal` aborts (an Error named "AbortError")
 * or `timeoutMs` passes (an Error with `timeoutMessage`). The losing promise keeps running;
 * its later rejection is handled here, so it never becomes an unhandled rejection.
 */
export function withAbortAndTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort);
  });
}

export function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

export type SerialGate = {
  /** Starts `task` only after every earlier task has settled. */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** True while an earlier task is queued or has not settled yet. */
  readonly busy: boolean;
};

/**
 * Runs async tasks one at a time. A task waits until the previous one SETTLED, even when its
 * caller already stopped waiting for it (timeout or abort): for native calls that throw when
 * called again too early, such as takePictureAsync.
 */
export function createSerialGate(): SerialGate {
  let tail: Promise<void> = Promise.resolve();
  let unsettled = 0;
  const settle = () => {
    unsettled--;
  };
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      unsettled++;
      const result = tail.then(task);
      tail = result.then(settle, settle);
      return result;
    },
    get busy() {
      return unsettled > 0;
    },
  };
}
