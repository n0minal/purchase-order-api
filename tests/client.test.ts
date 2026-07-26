import { describe, expect, it } from 'vitest'

import { DearAPIClient } from '../src/client.ts'
import { DearApiError } from '../src/errors.ts'
import { jsonResponse, silentLogger, stubFetch, testClient, testConfig } from './helpers.ts'

const LIST = { path: '/ExternalApi/v2/purchaseList' }
const passThrough = (body: unknown) => body

describe('URL building', () => {
  it('leaves out query values that are undefined or empty', async () => {
    const { fetch, requests } = stubFetch(() => jsonResponse({}))

    await testClient(fetch).get(
      { path: '/x', query: { Kept: 'yes', Empty: '', Missing: undefined, Zero: 0 } },
      passThrough,
    )

    const query = requests[0]!.url.searchParams
    expect(query.get('Kept')).toBe('yes')
    expect(query.has('Empty')).toBe(false)
    expect(query.has('Missing')).toBe(false)
    // Zero is a real value and must survive, unlike the empty string.
    expect(query.get('Zero')).toBe('0')
  })

  it('resolves the path against the configured base URL', async () => {
    const { fetch, requests } = stubFetch(() => jsonResponse({}))

    await testClient(fetch, { baseUrl: 'https://api.example.test' }).get(LIST, passThrough)

    expect(requests[0]!.url.toString()).toBe(
      'https://api.example.test/ExternalApi/v2/purchaseList',
    )
  })

  it('drops a base URL subpath when the endpoint path starts with a slash', async () => {
    // This is how the URL constructor behaves. Worth pinning down, because a base URL of
    // https://host/api/ would quietly lose the /api segment.
    const { fetch, requests } = stubFetch(() => jsonResponse({}))

    await testClient(fetch, { baseUrl: 'https://api.example.test/api/' }).get(
      { path: '/v2/purchaseList' },
      passThrough,
    )

    expect(requests[0]!.url.pathname).toBe('/v2/purchaseList')
  })
})

describe('reading the body', () => {
  it('returns whatever the read function returns', async () => {
    const { fetch } = stubFetch(() => jsonResponse({ Total: 7 }))

    const total = await testClient(fetch).get(LIST, (body) => (body as { Total: number }).Total)

    expect(total).toBe(7)
  })

  it('does not retry when the read function rejects the body', async () => {
    // Checking the shape happens after all retries, on purpose. A response in the wrong
    // shape fails the same way every attempt, so retrying it only wastes calls.
    let calls = 0
    const { fetch } = stubFetch(() => {
      calls++
      return jsonResponse({ wrong: true })
    })

    await expect(
      testClient(fetch, { maxRetries: 3 }).get(LIST, () => {
        throw new DearApiError('bad shape')
      }),
    ).rejects.toThrow('bad shape')

    expect(calls).toBe(1)
  })

  it('does not retry a success response whose body is not JSON', async () => {
    // Parsing sits with validation, after all retries: a broken body from a healthy
    // endpoint would come back broken again.
    let calls = 0
    const { fetch } = stubFetch(() => {
      calls++
      return new Response('<html>maintenance</html>', { status: 200 })
    })

    await expect(testClient(fetch, { maxRetries: 3 }).get(LIST, passThrough)).rejects.toThrow(
      /not JSON/,
    )
    expect(calls).toBe(1)
  })

  it('hands getText the body exactly as it arrived', async () => {
    // No parse and re-serialise round trip: 15.00 must stay 15.00.
    const raw = '{"ID":"a","InvoiceAmount":15.00}'
    const { fetch } = stubFetch(() => new Response(raw, { status: 200 }))

    await expect(testClient(fetch).getText(LIST)).resolves.toBe(raw)
  })
})

describe('retrying network failures', () => {
  it('retries a thrown network error and succeeds on the next attempt', async () => {
    let calls = 0
    const { fetch } = stubFetch(() => {
      calls++
      if (calls === 1) throw new TypeError('fetch failed')
      return jsonResponse({ ok: true })
    })

    await expect(testClient(fetch, { maxRetries: 1 }).get(LIST, passThrough)).resolves.toEqual({
      ok: true,
    })
    expect(calls).toBe(2)
  })

  it('gives up after the configured number of attempts and keeps the cause', async () => {
    let calls = 0
    const { fetch } = stubFetch(() => {
      calls++
      throw new TypeError('connection reset')
    })

    const error = await testClient(fetch, { maxRetries: 1 })
      .get(LIST, passThrough)
      .catch((e: unknown) => e)

    // maxRetries counts attempts after the first, so 1 means two calls in total.
    expect(calls).toBe(2)
    expect(error).toBeInstanceOf(DearApiError)
    expect((error as Error).message).toMatch(/failed after 2 attempts/)
    // Losing the cause here would leave no way to tell a DNS failure from a reset socket.
    expect((error as Error).cause).toBeInstanceOf(TypeError)
    expect(((error as Error).cause as Error).message).toBe('connection reset')
  })

  it('keeps the status on the error when the last failure came from a response', async () => {
    const { fetch } = stubFetch(
      () => new Response('busy', { status: 503, headers: { 'retry-after': '0' } }),
    )

    const error = (await testClient(fetch, { maxRetries: 1 })
      .get(LIST, passThrough)
      .catch((e: unknown) => e)) as DearApiError

    expect(error.status).toBe(503)
  })
})

describe('failing without retrying', () => {
  it('includes the response body in the message so the reason is visible', async () => {
    const { fetch } = stubFetch(() => new Response('invalid application key', { status: 403 }))

    await expect(testClient(fetch).get(LIST, passThrough)).rejects.toThrow(
      /invalid application key/,
    )
  })

  it('truncates a long error body rather than logging the whole page', async () => {
    const { fetch } = stubFetch(() => new Response('x'.repeat(5_000), { status: 400 }))

    const error = (await testClient(fetch)
      .get(LIST, passThrough)
      .catch((e: unknown) => e)) as Error

    expect(error.message.length).toBeLessThan(400)
  })
})

describe('cancellation and timeouts', () => {
  it('gives up on a request that outlives the timeout', async () => {
    const config = testConfig({ requestTimeoutMs: 30, maxRetries: 0 })
    // A server that never answers. Only the signal ends this.
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
      })

    const start = Date.now()
    await expect(
      new DearAPIClient(config, fetchImpl, silentLogger).get(LIST, passThrough),
    ).rejects.toThrow()
    expect(Date.now() - start).toBeLessThan(2_000)
  })

  it('stops immediately when the caller cancels, without spending a retry', async () => {
    const controller = new AbortController()
    let calls = 0
    const fetchImpl: typeof fetch = (_input, init) => {
      calls++
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
      })
    }
    const client = new DearAPIClient(testConfig({ maxRetries: 5 }), fetchImpl, silentLogger)

    const pending = client.get({ ...LIST, signal: controller.signal }, passThrough)
    setTimeout(() => controller.abort(new Error('Interrupted')), 20)

    await expect(pending).rejects.toThrow('Interrupted')
    // Cancelling is a decision the caller made, so it must not be retried.
    expect(calls).toBe(1)
  })

  it('refuses to start when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('too late'))
    let calls = 0
    const { fetch } = stubFetch(() => {
      calls++
      return jsonResponse({})
    })

    await expect(
      testClient(fetch).get({ ...LIST, signal: controller.signal }, passThrough),
    ).rejects.toThrow('too late')

    expect(calls).toBe(0)
  })
})
