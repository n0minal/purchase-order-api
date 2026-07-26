import { sleep } from './sleep.ts'

/**
 * Spaces out request starts so the documented calls-per-minute budget is respected,
 * rather than discovering the limit through 429 responses.
 *
 * Callers claim the next free slot synchronously, so concurrent requests queue in
 * arrival order and start at least one interval apart.
 */
export class RateLimiter {
  private readonly intervalMs: number
  private nextSlotAt = 0

  /**
   * @param intervalMs - minimum time between request starts. Zero or less disables the
   * limiter, which tests use to run without waiting.
   */
  constructor(intervalMs: number) {
    this.intervalMs = intervalMs
  }

  /**
   * Waits until the next slot is free.
   *
   * @param signal - optional signal that abandons the wait
   * @returns Resolves when the caller may start its request.
   */
  async wait(signal?: AbortSignal): Promise<void> {
    if (this.intervalMs <= 0) return

    const now = Date.now()
    const slot = Math.max(this.nextSlotAt, now)
    this.nextSlotAt = slot + this.intervalMs
    if (slot > now) await sleep(slot - now, signal)
  }
}
