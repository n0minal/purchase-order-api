import { DearApiError } from './errors.ts'
import { RateLimiter } from './rate-limiter.ts'
import { RetryPolicy } from './retry-policy.ts'
import { sleep } from './sleep.ts'
import type { Config, Logger, RequestOptions } from './types.ts'

/**
 * A small wrapper around fetch for the Cin7 Core API.
 *
 * It owns what every call site would otherwise repeat: authentication headers, a
 * timeout per request, client-side rate limiting, and retries on temporary failures.
 * When to retry and how long to wait is the RetryPolicy's decision; this class only
 * runs the loop.
 */
export class DearAPIClient {
  private readonly config: Config
  private readonly fetchImpl: typeof fetch
  private readonly logger: Logger
  private readonly limiter: RateLimiter
  private readonly retryPolicy: RetryPolicy

  /**
   * Creates a client bound to one set of credentials.
   *
   * @param config - base URL, credentials, timeout, retry and rate limit settings
   * @param fetchImpl - the fetch function to use. Tests pass a stand-in, which is why
   * no mock server library is needed.
   * @param logger - where retry warnings go. Defaults to console.
   */
  constructor(config: Config, fetchImpl: typeof fetch = fetch, logger: Logger = console) {
    this.config = config
    this.fetchImpl = fetchImpl
    this.logger = logger
    this.limiter = new RateLimiter(60_000 / config.callsPerMinute)
    this.retryPolicy = new RetryPolicy(config.maxRetries)
  }

  /**
   * Fetches JSON and hands it to a function that checks and shapes it.
   *
   * The return type comes from that function rather than from a type argument the
   * caller supplies, so the type describes data something actually looked at instead of
   * a claim nobody verified.
   *
   * @param options - path, query values and an optional cancellation signal
   * @param read - turns the decoded body into the value the caller wants
   * @returns Whatever read returns.
   * @throws DearApiError if the request fails or the body is not JSON, or whatever read
   * throws.
   */
  async get<T>(options: RequestOptions, read: (body: unknown) => T): Promise<T> {
    const text = await this.requestWithRetry(options)

    let body: unknown
    try {
      body = JSON.parse(text)
    } catch (cause) {
      throw new DearApiError(`GET ${options.path} returned a body that is not JSON`, undefined, {
        cause,
      })
    }
    return read(body)
  }

  /**
   * Fetches a response body without parsing or reshaping it.
   *
   * Used where the payload itself is the product: the text is returned exactly as it
   * arrived, so number formatting and field order survive untouched.
   *
   * @param options - path, query values and an optional cancellation signal
   * @returns The body text, byte for byte as the server sent it.
   * @throws DearApiError if the request fails.
   */
  async getText(options: RequestOptions): Promise<string> {
    return this.requestWithRetry(options)
  }

  /**
   * Builds the full request URL.
   *
   * URL and URLSearchParams handle escaping, so a search term containing "&" or "#"
   * stays inside its own parameter instead of adding new ones.
   *
   * @param path - endpoint path, resolved against the configured base URL
   * @param query - query values. Entries that are undefined or empty are left out.
   * @returns The finished URL as a string.
   */
  private buildUrl(path: string, query: RequestOptions['query'] = {}): string {
    const url = new URL(path, this.config.baseUrl)
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  /**
   * Sends the request, retrying temporary failures until the policy's limit is reached.
   *
   * Parsing and checking the body happen in get(), after all retries. A body in the
   * wrong shape fails the same way every attempt, so it should never cause one.
   *
   * @param options - path, query values and an optional cancellation signal
   * @returns The response body as text, still unparsed.
   * @throws DearApiError on a non-retryable status, or once attempts run out.
   */
  private async requestWithRetry(options: RequestOptions): Promise<string> {
    const url = this.buildUrl(options.path, options.query)
    let lastError: unknown

    for (let attempt = 0; attempt <= this.retryPolicy.maxRetries; attempt++) {
      options.signal?.throwIfAborted()

      // Every attempt is a call against the rate limit, so every attempt claims a slot.
      await this.limiter.wait(options.signal)

      // Both the caller's signal and our own timeout need to be able to stop this request.
      const timeout = AbortSignal.timeout(this.config.requestTimeoutMs)
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout

      try {
        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'api-auth-accountid': this.config.accountId,
            'api-auth-applicationkey': this.config.applicationKey,
          },
          signal,
        })

        if (response.ok) return await response.text()

        // Read the body so the connection can go back in the pool.
        const body = await response.text().catch(() => '')
        const error = new DearApiError(
          `GET ${options.path} failed: ${response.status} ${response.statusText}${
            body ? `: ${body.slice(0, 200)}` : ''
          }`,
          response.status,
        )

        if (!this.retryPolicy.shouldRetry(response.status)) throw error
        lastError = error

        const wait = this.retryPolicy.delayFor(attempt, response.headers.get('retry-after'))
        if (attempt < this.retryPolicy.maxRetries) {
          this.logger.warn(
            `Retrying ${options.path} after ${response.status}, ` +
              `attempt ${attempt + 1}, waiting ${Math.round(wait)}ms`,
          )
          await sleep(wait, options.signal)
        }
      } catch (error) {
        // Cancelling is a choice the caller made, so it is never retried.
        if (options.signal?.aborted) throw error
        if (error instanceof DearApiError && !this.retryPolicy.shouldRetry(error.status ?? 0)) {
          throw error
        }

        lastError = error
        if (attempt < this.retryPolicy.maxRetries) {
          const wait = this.retryPolicy.delayFor(attempt)
          const message = error instanceof Error ? error.message : String(error)
          this.logger.warn(
            `Retrying ${options.path} after a network error, ` +
              `attempt ${attempt + 1}, waiting ${Math.round(wait)}ms: ${message}`,
          )
          await sleep(wait, options.signal)
        }
      }
    }

    throw new DearApiError(
      `GET ${options.path} failed after ${this.retryPolicy.maxRetries + 1} attempts`,
      lastError instanceof DearApiError ? lastError.status : undefined,
      { cause: lastError },
    )
  }
}
