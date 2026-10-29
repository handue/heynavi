/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSerialGate, withAbortAndTimeout } from './async.ts';

const never = <T>() => new Promise<T>(() => {});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('withAbortAndTimeout', () => {
  it('resolves with the value when the promise settles first', async () => {
    const value = await withAbortAndTimeout(Promise.resolve(42), new AbortController().signal, 1000, 'late');
    assert.equal(value, 42);
  });

  it('passes a rejection through', async () => {
    await assert.rejects(
      withAbortAndTimeout(Promise.reject(new Error('camera broke')), undefined, 1000, 'late'),
      { message: 'camera broke' },
    );
  });

  it('rejects with the timeout message when the promise hangs', async () => {
    const started = Date.now();
    await assert.rejects(withAbortAndTimeout(never(), undefined, 20, 'Frame 1 timed out after 5 s.'), {
      message: 'Frame 1 timed out after 5 s.',
    });
    assert.ok(Date.now() - started < 500);
  });

  it('rejects with an AbortError as soon as the signal aborts', async () => {
    const controller = new AbortController();
    const raced = withAbortAndTimeout(never(), controller.signal, 10_000, 'late');
    controller.abort();
    await assert.rejects(raced, { name: 'AbortError' });
  });

  it('rejects at once when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(withAbortAndTimeout(never(), controller.signal, 10_000, 'late'), {
      name: 'AbortError',
    });
  });

  it('handles a late rejection of the losing promise', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const late = deferred<number>();
      const controller = new AbortController();
      const raced = withAbortAndTimeout(late.promise, controller.signal, 10_000, 'late');
      controller.abort();
      await assert.rejects(raced, { name: 'AbortError' });
      late.reject(new Error('CameraNotReadyException'));
      await tick();
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('createSerialGate', () => {
  it('does not start a task until the previous one settled, even after its caller gave up', async () => {
    const gate = createSerialGate();
    const first = deferred<string>();
    const started: string[] = [];

    const firstRun = gate.run(() => {
      started.push('first');
      return first.promise;
    });
    // The first caller stops waiting (like a cancelled or timed-out capture).
    await assert.rejects(withAbortAndTimeout(firstRun, undefined, 10, 'timed out'), {
      message: 'timed out',
    });
    assert.equal(gate.busy, true);

    const secondRun = gate.run(async () => {
      started.push('second');
      return 'second';
    });
    await tick();
    assert.deepEqual(started, ['first'], 'second task must wait for the pending native call');

    first.resolve('first');
    assert.equal(await secondRun, 'second');
    assert.deepEqual(started, ['first', 'second']);
    await tick();
    assert.equal(gate.busy, false);
  });

  it('keeps going after a task rejects', async () => {
    const gate = createSerialGate();
    const failed = gate.run(() => Promise.reject(new Error('busy')));
    const next = gate.run(async () => 'ok');
    await assert.rejects(failed, { message: 'busy' });
    assert.equal(await next, 'ok');
  });

  it('is not busy when idle', () => {
    assert.equal(createSerialGate().busy, false);
  });
});
