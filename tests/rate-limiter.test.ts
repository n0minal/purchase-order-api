import { afterEach, describe, expect, it, vi } from 'vitest'

import { RateLimiter } from '../src/rate-limiter.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('RateLimiter', () => {
  it('lets the first call start straight away', async () => {
    vi.useFakeTimers()
    const limiter = new RateLimiter(1_000)

    // With fake timers, a wait that wrongly claimed a delay would hang this test.
    await limiter.wait()
  })

  it('spaces concurrent calls one interval apart', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const limiter = new RateLimiter(1_000)
    const startedAt: number[] = []

    const all = Promise.all([
      limiter.wait().then(() => startedAt.push(Date.now())),
      limiter.wait().then(() => startedAt.push(Date.now())),
      limiter.wait().then(() => startedAt.push(Date.now())),
    ])
    await vi.advanceTimersByTimeAsync(2_000)
    await all

    expect(startedAt).toEqual([0, 1_000, 2_000])
  })

  it('gives back the wait when the caller cancels', async () => {
    vi.useFakeTimers()
    const limiter = new RateLimiter(60_000)
    const controller = new AbortController()

    await limiter.wait()
    const queued = limiter.wait(controller.signal)
    controller.abort(new Error('cancelled'))

    await expect(queued).rejects.toThrow('cancelled')
  })

  it('does nothing at an interval of zero or less', async () => {
    vi.useFakeTimers()
    const limiter = new RateLimiter(0)

    // Neither call may touch a timer, or this test would hang under fake timers.
    await limiter.wait()
    await limiter.wait()
  })
})
