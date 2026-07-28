/**
 * Waits for a set time, giving up early if the caller cancels.
 *
 * A signal that is already aborted is checked up front, because adding a listener to one
 * does not fire it and the wait would run to completion. The listener is also removed once
 * the timer wins, otherwise every completed wait would leave one attached to a signal that
 * lives as long as the run.
 *
 * @param durationMs - how long to wait, in milliseconds
 * @param signal - optional signal that cancels the wait
 * @returns Resolves when the time is up, rejects with the signal's reason if cancelled
 * first.
 */
export function sleep(durationMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    let timer: ReturnType<typeof setTimeout>;

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };

    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
