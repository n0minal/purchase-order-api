import { describe, expect, it } from 'vitest';

import { PurchaseOrderFetcher } from '../src/purchase-order-fetcher.ts';
import type {
  ApiReader,
  FetchOptions,
  FetchSummary,
  JsonValue,
  OrderWriter,
  RequestOptions,
} from '../src/types.ts';
import {
  baseFetchOptions,
  collectWrites,
  isPurchaseListRequest,
  jsonResponse,
  purchaseListPageResponse,
  stubFetch,
  testClient,
} from './helpers.ts';

/**
 * Builds a fetcher and runs it, which is what almost every test here does once.
 *
 * @param client - API client or stand-in
 * @param writer - where orders go
 * @param options - run options
 * @returns The run summary.
 */
function runFetch(
  client: ApiReader,
  writer: OrderWriter,
  options: FetchOptions,
): Promise<FetchSummary> {
  return new PurchaseOrderFetcher(client, writer, options).run();
}

describe('pagination', () => {
  it('walks every page and stops once Total is reached', async () => {
    const { fetch, requests } = stubFetch((url) => {
      if (!isPurchaseListRequest(url)) return jsonResponse({ ID: url.searchParams.get('ID') });
      const page = Number(url.searchParams.get('Page'));
      return page === 1
        ? purchaseListPageResponse(['a', 'b'], 3)
        : purchaseListPageResponse(['c'], 3);
    });

    const { written, writer } = collectWrites();
    const summary = await runFetch(testClient(fetch), writer, baseFetchOptions({ pageSize: 2 }));

    expect(summary.listed).toBe(3);
    expect(summary.succeeded).toBe(3);
    expect([...written.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(requests.filter((r) => isPurchaseListRequest(r.url))).toHaveLength(2);
  });

  it('fetches an order only once when page drift lists it twice', async () => {
    // A record updated while the run is paging can shift between pages and be listed
    // on two of them.
    const { fetch, requests } = stubFetch((url) => {
      if (!isPurchaseListRequest(url)) return jsonResponse({ ID: url.searchParams.get('ID') });
      const page = Number(url.searchParams.get('Page'));
      return page === 1
        ? purchaseListPageResponse(['a', 'b'], 4)
        : purchaseListPageResponse(['b', 'c'], 4);
    });

    const { written, writer } = collectWrites();
    const summary = await runFetch(testClient(fetch), writer, baseFetchOptions({ pageSize: 2 }));

    expect(summary.listed).toBe(3);
    expect([...written.keys()].sort()).toEqual(['a', 'b', 'c']);
    const detailIds = requests
      .filter((r) => !isPurchaseListRequest(r.url))
      .map((r) => r.url.searchParams.get('ID'));
    expect(detailIds.filter((id) => id === 'b')).toHaveLength(1);
  });
});

describe('request construction', () => {
  it('percent-encodes search terms instead of splicing them into the query', async () => {
    const { fetch, requests } = stubFetch((url) =>
      isPurchaseListRequest(url) ? purchaseListPageResponse([], 0) : jsonResponse({}),
    );

    await runFetch(
      testClient(fetch),
      collectWrites().writer,
      baseFetchOptions({ search: 'widgets & bolts #2', status: 'AUTHORISED' }),
    );

    const [first] = requests;
    expect(first).toBeDefined();
    // The raw query keeps the ampersand escaped, so it cannot introduce a new parameter.
    expect(first!.url.search).toContain('Search=widgets+%26+bolts+%232');
    expect(first!.url.searchParams.get('Search')).toBe('widgets & bolts #2');
    expect(first!.url.searchParams.get('Status')).toBe('AUTHORISED');
  });

  it('sends the date filter as an unambiguous UTC instant', async () => {
    const { fetch, requests } = stubFetch((url) =>
      isPurchaseListRequest(url) ? purchaseListPageResponse([], 0) : jsonResponse({}),
    );

    await runFetch(
      testClient(fetch),
      collectWrites().writer,
      baseFetchOptions({ dateFilter: 'UpdatedSince' }),
    );

    expect(requests[0]!.url.searchParams.get('UpdatedSince')).toBe('2026-01-01T00:00:00.000Z');
  });

  it('never sends CreatedSince, which /purchaseList does not support', async () => {
    // The endpoint ignores unknown parameters instead of rejecting them, so sending
    // createdSince would silently return every purchase order ever created.
    const { fetch, requests } = stubFetch((url) =>
      isPurchaseListRequest(url) ? purchaseListPageResponse([], 0) : jsonResponse({}),
    );

    await runFetch(testClient(fetch), collectWrites().writer, baseFetchOptions());

    const query = requests[0]!.url.searchParams;
    expect(query.get('createdSince')).toBeNull();
    expect(query.get('CreatedSince')).toBeNull();
    expect(query.get('UpdatedSince')).toBe('2026-01-01T00:00:00.000Z');
  });

  it('attaches the authentication headers to every request', async () => {
    const { fetch, requests } = stubFetch((url) =>
      isPurchaseListRequest(url) ? purchaseListPageResponse(['a'], 1) : jsonResponse({ ID: 'a' }),
    );

    await runFetch(testClient(fetch), collectWrites().writer, baseFetchOptions());

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.headers.get('api-auth-accountid')).toBe('test-account');
      expect(request.headers.get('api-auth-applicationkey')).toBe('test-key');
    }
  });
});

describe('resilience', () => {
  it('retries a 429 and honours Retry-After', async () => {
    let listCalls = 0;
    const { fetch } = stubFetch((url) => {
      if (!isPurchaseListRequest(url)) return jsonResponse({ ID: 'a' });
      listCalls++;
      if (listCalls === 1) {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
      }
      return purchaseListPageResponse(['a'], 1);
    });

    const summary = await runFetch(testClient(fetch), collectWrites().writer, baseFetchOptions());

    expect(listCalls).toBe(2);
    expect(summary.succeeded).toBe(1);
  });

  it('does not retry a client error', async () => {
    let calls = 0;
    const { fetch } = stubFetch(() => {
      calls++;
      return new Response('bad credentials', { status: 401 });
    });

    await expect(
      runFetch(testClient(fetch), collectWrites().writer, baseFetchOptions()),
    ).rejects.toThrow(/401/);

    expect(calls).toBe(1);
  });

  it('reports a failed detail fetch without abandoning the rest of the run', async () => {
    const { fetch } = stubFetch((url) => {
      if (isPurchaseListRequest(url)) return purchaseListPageResponse(['good', 'bad'], 2);
      return url.searchParams.get('ID') === 'bad'
        ? new Response('gone', { status: 404 })
        : jsonResponse({ ID: 'good' });
    });

    const { written, writer } = collectWrites();
    const summary = await runFetch(
      testClient(fetch, { maxRetries: 0 }),
      writer,
      baseFetchOptions(),
    );

    expect(summary.succeeded).toBe(1);
    expect(summary.failedCount).toBe(1);
    expect(summary.failures[0]!.id).toBe('bad');
    expect([...written.keys()]).toEqual(['good']);
  });
});

describe('validation', () => {
  it('skips a list entry with no usable ID and keeps the rest of the page', async () => {
    const { fetch } = stubFetch((url) => {
      if (!isPurchaseListRequest(url)) return jsonResponse({ ID: url.searchParams.get('ID') });
      // A null ID must not turn into the string "null" inside a request URL.
      return jsonResponse({ Total: 2, PurchaseList: [{ ID: 'good' }, { ID: null }] });
    });

    const { written, writer } = collectWrites();
    const summary = await runFetch(testClient(fetch), writer, baseFetchOptions());

    expect(summary.listed).toBe(1);
    expect([...written.keys()]).toEqual(['good']);
  });

  it('rejects a response whose envelope does not match the contract', async () => {
    const { fetch } = stubFetch(() => jsonResponse({ Total: 'not-a-number', PurchaseList: [] }));

    await expect(
      runFetch(testClient(fetch), collectWrites().writer, baseFetchOptions()),
    ).rejects.toThrow(/Total/);
  });

  it('accepts the nulls and mixed date formats the vendor actually sends', async () => {
    // Straight from the published sample payload. Nothing here is inspected, so nothing
    // here should be able to fail a run.
    const { fetch } = stubFetch((url) => {
      if (!isPurchaseListRequest(url)) return jsonResponse({ ID: 'a' });
      return jsonResponse({
        Total: 1,
        Page: 1,
        PurchaseList: [
          {
            ID: 'a',
            RequiredBy: null,
            DropShipTaskID: null,
            InvoiceAmount: 15,
            OrderDate: '2018-02-22T00:00:00',
            LastUpdatedDate: '2018-04-19T04:03:06.52Z',
          },
        ],
      });
    });

    const summary = await runFetch(testClient(fetch), collectWrites().writer, baseFetchOptions());

    expect(summary.listed).toBe(1);
    expect(summary.succeeded).toBe(1);
  });

  it('writes the detail payload byte for byte as it arrived', async () => {
    // The files are the product, so nothing may reshape them, including fields added
    // after this code was written. Writing a re-serialised copy would rewrite number
    // formatting (15.00 becomes 15) and lose precision beyond 15 digits.
    const raw =
      '{"ID":"a","InvoiceAmount":15.00,"BigNumber":9007199254740993,' +
      '"SomeFieldAddedNextQuarter":{"nested":true}}';
    const { fetch } = stubFetch((url) =>
      isPurchaseListRequest(url)
        ? purchaseListPageResponse(['a'], 1)
        : new Response(raw, { status: 200 }),
    );

    const { written, writer } = collectWrites();
    await runFetch(testClient(fetch), writer, baseFetchOptions());

    expect(written.get('a')).toBe(raw);
  });

  it('records a failure when a detail body is not JSON at all', async () => {
    const { fetch } = stubFetch((url) =>
      isPurchaseListRequest(url)
        ? purchaseListPageResponse(['a'], 1)
        : new Response('<html>maintenance</html>', { status: 200 }),
    );

    const { written, writer } = collectWrites();
    const summary = await runFetch(testClient(fetch), writer, baseFetchOptions());

    expect(summary.succeeded).toBe(0);
    expect(summary.failedCount).toBe(1);
    expect(summary.failures[0]!.error).toMatch(/not valid JSON/);
    expect(written.size).toBe(0);
  });

  it('records a failure when a detail body is JSON but not an object', async () => {
    // A scalar or an array is parseable, but archiving it as an order would be wrong.
    const { fetch } = stubFetch((url) =>
      isPurchaseListRequest(url) ? purchaseListPageResponse(['a'], 1) : jsonResponse([1, 2, 3]),
    );

    const { written, writer } = collectWrites();
    const summary = await runFetch(testClient(fetch), writer, baseFetchOptions());

    expect(summary.failedCount).toBe(1);
    expect(summary.failures[0]!.error).toMatch(/failed validation/);
    expect(written.size).toBe(0);
  });
});

describe('concurrency', () => {
  it('keeps no more than maxConcurrency detail requests in flight', async () => {
    // The API allows 60 calls a minute and this makes one call per order, so overlapping
    // requests have to stay capped.
    let inFlight = 0;
    let peak = 0;

    const { fetch } = stubFetch(async (url) => {
      if (isPurchaseListRequest(url))
        return purchaseListPageResponse(
          Array.from({ length: 12 }, (_, i) => `PO-${i}`),
          12,
        );

      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight--;
      return jsonResponse({ ID: url.searchParams.get('ID') });
    });

    const summary = await runFetch(
      testClient(fetch),
      collectWrites().writer,
      baseFetchOptions({ pageSize: 20, maxConcurrency: 3 }),
    );

    expect(summary.succeeded).toBe(12);
    expect(peak).toBeLessThanOrEqual(3);
    // Without overlap this would be 1, which would mean the pool is not doing its job.
    expect(peak).toBeGreaterThan(1);
  });

  it('still fetches everything when maxConcurrency is 1', async () => {
    let peak = 0;
    let inFlight = 0;

    const { fetch } = stubFetch(async (url) => {
      if (isPurchaseListRequest(url)) return purchaseListPageResponse(['a', 'b', 'c'], 3);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return jsonResponse({ ID: url.searchParams.get('ID') });
    });

    const { written, writer } = collectWrites();
    await runFetch(
      testClient(fetch),
      writer,
      baseFetchOptions({ pageSize: 10, maxConcurrency: 1 }),
    );

    expect([...written.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(peak).toBe(1);
  });
});

describe('cancellation', () => {
  it('stops making detail requests once the caller cancels', async () => {
    const controller = new AbortController();
    let detailCalls = 0;

    const { fetch } = stubFetch(async (url) => {
      if (isPurchaseListRequest(url))
        return purchaseListPageResponse(
          Array.from({ length: 40 }, (_, i) => `PO-${i}`),
          40,
        );

      detailCalls++;
      if (detailCalls === 3) controller.abort(new Error('Interrupted'));
      await new Promise((resolve) => setTimeout(resolve, 5));
      return jsonResponse({ ID: url.searchParams.get('ID') });
    });

    const summary = await runFetch(
      testClient(fetch),
      collectWrites().writer,
      baseFetchOptions({ pageSize: 50, maxConcurrency: 2, signal: controller.signal }),
    );

    // The run ends far short of the 40 listed orders rather than working through them all.
    expect(detailCalls).toBeLessThan(40);
    expect(summary.succeeded).toBeLessThan(40);
  });

  it('refuses to request the next page after the signal aborts', async () => {
    const controller = new AbortController();
    const { fetch } = stubFetch((url) => {
      if (!isPurchaseListRequest(url)) return jsonResponse({ ID: url.searchParams.get('ID') });
      // Aborting during the first page means every request after it, details and page
      // two alike, must refuse to start.
      controller.abort(new Error('stopped'));
      return purchaseListPageResponse(['a', 'b'], 4);
    });

    const { written, writer } = collectWrites();
    await expect(
      runFetch(
        testClient(fetch),
        writer,
        baseFetchOptions({ pageSize: 2, signal: controller.signal }),
      ),
    ).rejects.toThrow('stopped');

    expect(written.size).toBe(0);
  });
});

describe('failure reporting', () => {
  it('stops storing failure details past the cap so an outage cannot fill memory', async () => {
    const { fetch } = stubFetch((url) => {
      if (isPurchaseListRequest(url))
        return purchaseListPageResponse(
          Array.from({ length: 105 }, (_, i) => `PO-${i}`),
          105,
        );
      // 404 is not retryable, so each order fails on its first attempt.
      return new Response('gone', { status: 404 });
    });

    const summary = await runFetch(
      testClient(fetch),
      collectWrites().writer,
      baseFetchOptions({ pageSize: 200 }),
    );

    expect(summary.listed).toBe(105);
    expect(summary.failedCount).toBe(105);
    // Every failure is counted, but only the first hundred are kept in detail.
    expect(summary.failures).toHaveLength(100);
  });

  it('reports nothing failed on a clean run', async () => {
    const { fetch } = stubFetch((url) =>
      isPurchaseListRequest(url) ? purchaseListPageResponse(['a'], 1) : jsonResponse({ ID: 'a' }),
    );

    const summary = await runFetch(testClient(fetch), collectWrites().writer, baseFetchOptions());

    expect(summary).toEqual({ listed: 1, succeeded: 1, failedCount: 0, failures: [] });
  });

  it('does not write a file for an order that could not be fetched', async () => {
    const { fetch } = stubFetch((url) =>
      isPurchaseListRequest(url)
        ? purchaseListPageResponse(['bad'], 1)
        : new Response('boom', { status: 500 }),
    );

    const { written, writer } = collectWrites();
    await runFetch(testClient(fetch, { maxRetries: 0 }), writer, baseFetchOptions());

    expect(written.size).toBe(0);
  });
});

describe('the PurchaseOrderFetcher class', () => {
  it('keeps run tallies local, so a reused fetcher starts each run from zero', async () => {
    const { fetch } = stubFetch((url) =>
      isPurchaseListRequest(url) ? purchaseListPageResponse(['a'], 1) : jsonResponse({ ID: 'a' }),
    );
    const fetcher = new PurchaseOrderFetcher(
      testClient(fetch),
      collectWrites().writer,
      baseFetchOptions(),
    );

    const first = await fetcher.run();
    const second = await fetcher.run();

    expect(first.listed).toBe(1);
    // A summary held on the instance would report 2 here.
    expect(second.listed).toBe(1);
    expect(second.succeeded).toBe(1);
  });

  it('accepts any object with the two ApiReader methods, not just DearApiClient', async () => {
    // This is the point of depending on ApiReader: the private fields on DearApiClient
    // make the class nominally typed, so a plain stand-in like this one would otherwise
    // be rejected by the compiler.
    const reader: ApiReader = {
      async get<T>(_options: RequestOptions, read: (body: JsonValue) => T): Promise<T> {
        return read({ Total: 1, PurchaseList: [{ ID: 'offline-1' }] });
      },
      async getText(): Promise<string> {
        return '{"ID":"offline-1","Source":"fixture"}';
      },
    };

    const { written, writer } = collectWrites();
    const summary = await runFetch(reader, writer, baseFetchOptions());

    expect(summary.succeeded).toBe(1);
    expect(JSON.parse(written.get('offline-1')!).Source).toBe('fixture');
  });
});
