/** First wait when the server gave no guidance. Doubles each attempt. */
const BASE_DELAY_MS = 500;

/** Random amount added to each wait so requests that failed together spread out. */
const MAX_JITTER_MS = 250;

/** Ceiling for the doubling backoff. */
const BACKOFF_CAP_MS = 20_000;

/** Longest wait between attempts, whatever Retry-After asks for. */
const WAIT_CAP_MS = 60_000;

/**
 * Reads a Retry-After header so the wait matches what the server asked for. The header
 * holds either a number of seconds or an HTTP date.
 *
 * @param header - raw header value, or null if the server did not send one
 * @returns Milliseconds to wait, or undefined if there was no usable value.
 */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const value = header.trim();

  // Anything that reads as a number is the seconds form, and a bad one gives up here
  // rather than falling through. Date.parse("-5") is a date in 2001, so a malformed value
  // would otherwise come back as 0 and retry at once against a server that just asked us
  // to slow down. Returning undefined hands the decision to the backoff instead.
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) {
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
  }

  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());

  return undefined;
}

/**
 * When a failed request is worth trying again, and how long to wait before doing so.
 *
 * The whole policy lives here: the attempt budget, which statuses count as temporary,
 * the doubling backoff with jitter, and how far a server's Retry-After is trusted.
 */
export class RetryPolicy {
  /** Attempts after the first one. Zero means one attempt with no retries. */
  readonly maxRetries: number;

  /**
   * @param maxRetries - attempts after the first one
   */
  constructor(maxRetries: number) {
    this.maxRetries = maxRetries;
  }

  /**
   * Decides whether a failed status is worth trying again.
   *
   * 429 and 5xx are temporary. A 4xx such as bad credentials will fail the same way
   * every time, so retrying it only wastes calls against the rate limit.
   *
   * @param status - HTTP status code from the response
   * @returns True if the request should be retried.
   */
  shouldRetry(status: number): boolean {
    return status === 429 || status >= 500;
  }

  /**
   * Works out how long to wait before the next attempt.
   *
   * A usable Retry-After header wins, because the server knows its own load. Otherwise
   * the wait doubles each attempt with a little jitter. Either way the result is capped
   * at sixty seconds, so a server bug cannot stall the run for hours.
   *
   * @param attempt - zero based number of the attempt that just failed
   * @param retryAfterHeader - raw Retry-After value, or null when the failure had none
   * @returns Milliseconds to wait.
   */
  delayFor(attempt: number, retryAfterHeader: string | null = null): number {
    const backoff = Math.min(
      BASE_DELAY_MS * 2 ** attempt + Math.random() * MAX_JITTER_MS,
      BACKOFF_CAP_MS,
    );
    return Math.min(parseRetryAfter(retryAfterHeader) ?? backoff, WAIT_CAP_MS);
  }
}
