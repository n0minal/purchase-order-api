import { DearAPIClient } from '../src/client.ts'
import type { Config, Logger, OrderWriter } from '../src/types.ts'

/**
 * Discards everything. Passed wherever a Logger is accepted, so expected retries and
 * failures do not bury the test report.
 */
export const silentLogger: Logger = { warn: () => {}, error: () => {} }

/**
 * Builds a Config for tests, with small values so runs finish quickly.
 *
 * @param overrides - fields to change for one specific test
 * @returns A complete Config object.
 */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    baseUrl: 'https://api.example.test',
    accountId: 'test-account',
    applicationKey: 'test-key',
    outputDir: '/tmp/does-not-exist',
    maxConcurrency: 4,
    pageSize: 2,
    // No spacing between requests, so tests run without waiting.
    callsPerMinute: Number.POSITIVE_INFINITY,
    requestTimeoutMs: 1_000,
    maxRetries: 2,
    ...overrides,
  }
}

/**
 * Builds a client wired to a stand-in fetch and a silent logger.
 *
 * @param fetchImpl - the fetch stand-in, usually from stubFetch
 * @param overrides - Config fields to change for one specific test
 * @returns A DearAPIClient ready to use in a test.
 */
export function testClient(
  fetchImpl: typeof fetch,
  overrides: Partial<Config> = {},
): DearAPIClient {
  return new DearAPIClient(testConfig(overrides), fetchImpl, silentLogger)
}

/**
 * Builds a writer that keeps orders in memory instead of on disk. An object literal is
 * a complete OrderWriter, which is the point of the interface.
 *
 * @returns The map of what was written, and the writer to pass to a fetcher.
 */
export function collectWrites(): { written: Map<string, string>; writer: OrderWriter } {
  const written = new Map<string, string>()
  return {
    written,
    writer: {
      write: async (id, contents) => {
        written.set(id, contents)
      },
    },
  }
}

/** One request the stub saw, kept so tests can assert on the URL and headers. */
export interface RecordedRequest {
  url: URL
  headers: Headers
}

/**
 * Builds a stand-in for fetch that records calls and returns canned responses.
 *
 * DearAPIClient takes its fetch as a constructor argument, so a plain function is enough
 * and no mock server library is needed.
 *
 * @param handler - returns the response for a given URL. Also receives the zero based
 * call number, so a test can answer differently on a second attempt.
 * @returns The stub fetch and the array of requests it has seen so far.
 */
export function stubFetch(handler: (url: URL, callIndex: number) => Response | Promise<Response>): {
  fetch: typeof fetch
  requests: RecordedRequest[]
} {
  const requests: RecordedRequest[] = []

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : String(input))
    requests.push({ url, headers: new Headers(init?.headers) })
    return await handler(url, requests.length - 1)
  }

  return { fetch: fetchImpl, requests }
}

/**
 * Builds a JSON response for the stub to return.
 *
 * @param body - value to serialise into the response body
 * @param init - status and headers to override the defaults
 * @returns A Response with status 200 and a JSON content type unless overridden.
 */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

/**
 * Builds one page of the purchase list containing the given IDs.
 *
 * @param ids - order IDs to place on this page
 * @param total - value to report in the Total field of the envelope
 * @returns A Response shaped like a purchase list page.
 */
export function listPage(ids: string[], total: number): Response {
  return jsonResponse({ Total: total, PurchaseList: ids.map((ID) => ({ ID })) })
}
