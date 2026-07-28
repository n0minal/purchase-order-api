import { describe, expect, it } from 'vitest';

import { RetryPolicy } from '../src/retry-policy.ts';

const policy = new RetryPolicy(3);

describe('maxRetries', () => {
  it('exposes the attempt budget it was built with', () => {
    expect(new RetryPolicy(3).maxRetries).toBe(3);
    expect(new RetryPolicy(0).maxRetries).toBe(0);
  });
});

describe('shouldRetry', () => {
  it('retries rate limiting and server faults', () => {
    expect(policy.shouldRetry(429)).toBe(true);
    expect(policy.shouldRetry(500)).toBe(true);
    expect(policy.shouldRetry(503)).toBe(true);
  });

  it('gives up on a request the server will reject the same way every time', () => {
    // Retrying bad credentials just burns calls against the 60 per minute limit.
    expect(policy.shouldRetry(401)).toBe(false);
    expect(policy.shouldRetry(403)).toBe(false);
    expect(policy.shouldRetry(404)).toBe(false);
    expect(policy.shouldRetry(400)).toBe(false);
  });

  it('treats 499 as final and 500 as temporary', () => {
    expect(policy.shouldRetry(499)).toBe(false);
    expect(policy.shouldRetry(500)).toBe(true);
  });
});

describe('delayFor without server guidance', () => {
  it('doubles the wait on each attempt', () => {
    // Jitter adds up to 250ms, so each attempt is checked as a range.
    expect(policy.delayFor(0)).toBeGreaterThanOrEqual(500);
    expect(policy.delayFor(0)).toBeLessThan(750);
    expect(policy.delayFor(1)).toBeGreaterThanOrEqual(1_000);
    expect(policy.delayFor(1)).toBeLessThan(1_250);
    expect(policy.delayFor(2)).toBeGreaterThanOrEqual(2_000);
    expect(policy.delayFor(2)).toBeLessThan(2_250);
  });

  it('caps the wait so a high attempt count cannot stall the run for hours', () => {
    expect(policy.delayFor(20)).toBe(20_000);
    expect(policy.delayFor(100)).toBe(20_000);
  });

  it('varies between calls so requests that failed together do not all return at once', () => {
    const delays = new Set(Array.from({ length: 20 }, () => policy.delayFor(0)));
    expect(delays.size).toBeGreaterThan(1);
  });
});

describe('delayFor with a Retry-After header', () => {
  it('obeys the seconds form', () => {
    expect(policy.delayFor(0, '30')).toBe(30_000);
    expect(policy.delayFor(5, '0')).toBe(0);
  });

  it('obeys the HTTP date form', () => {
    const twoSecondsOut = new Date(Date.now() + 2_000).toUTCString();
    const wait = policy.delayFor(0, twoSecondsOut);

    // toUTCString drops milliseconds, so the value lands near two seconds rather than on it.
    expect(wait).toBeGreaterThan(500);
    expect(wait).toBeLessThanOrEqual(2_000);
  });

  it('never asks the caller to wait a negative amount of time', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(policy.delayFor(0, past)).toBe(0);
  });

  it('caps the server request at sixty seconds', () => {
    // A server bug asking for an hour must not stall the run for an hour.
    expect(policy.delayFor(0, '3600')).toBe(60_000);
  });

  it('falls back to backoff when there is no usable value', () => {
    for (const header of [null, '', 'soon', 'Infinity']) {
      const wait = policy.delayFor(0, header);
      expect(wait).toBeGreaterThanOrEqual(500);
      expect(wait).toBeLessThan(750);
    }
  });

  it('does not turn a negative seconds value into an immediate retry', () => {
    // Regression test. "-5" fails the seconds check, and Date.parse("-5") is a date in
    // 2001, so this used to come back as 0 and retry at once against a server that had
    // just rate limited us. Backoff has to take over instead.
    expect(policy.delayFor(0, '-5')).toBeGreaterThanOrEqual(500);
    expect(policy.delayFor(0, '-100')).toBeGreaterThanOrEqual(500);
  });

  it('ignores surrounding whitespace', () => {
    expect(policy.delayFor(0, '  30  ')).toBe(30_000);
  });
});
