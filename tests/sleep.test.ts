import { getEventListeners } from 'node:events'

import { describe, expect, it } from 'vitest'

import { sleep } from '../src/sleep.ts'

describe('sleep', () => {
  it('waits for the time it was given', async () => {
    const start = Date.now()
    await sleep(50)
    expect(Date.now() - start).toBeGreaterThanOrEqual(45)
  })

  it('stops early when the caller cancels part way through', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('interrupted')), 20)

    const start = Date.now()
    await expect(sleep(5_000, controller.signal)).rejects.toThrow('interrupted')
    expect(Date.now() - start).toBeLessThan(1_000)
  })

  it('rejects at once when the signal was already aborted', async () => {
    // Regression test. Adding an abort listener to a signal that has already aborted does
    // not fire it, so this used to wait the full duration after the caller had given up.
    const controller = new AbortController()
    controller.abort(new Error('already gone'))

    const start = Date.now()
    await expect(sleep(5_000, controller.signal)).rejects.toThrow('already gone')
    expect(Date.now() - start).toBeLessThan(100)
  })

  it('leaves no listener behind when the timer wins', async () => {
    // Regression test. The signal passed in lives for the whole run, so a listener kept
    // after every completed wait accumulated one per retry.
    const controller = new AbortController()
    for (let i = 0; i < 15; i++) await sleep(1, controller.signal)

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('works without a signal at all', async () => {
    await expect(sleep(1)).resolves.toBeUndefined()
  })
})
