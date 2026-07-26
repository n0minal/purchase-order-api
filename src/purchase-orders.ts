import {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_PAGE_SIZE,
  MAX_RECORDED_FAILURES,
  PURCHASE_LIST_PATH,
  PURCHASE_PATH,
} from './constants.ts'
import { DearApiError } from './errors.ts'
import type { ApiReader, FetchOptions, FetchSummary, Logger, OrderWriter } from './types.ts'

/** One page of the purchase list, reduced to what this application uses. */
interface ListPage {
  total: number
  ids: string[]
  /** Entries with no usable ID. Counted so paging does not stall on them. */
  skipped: number
}

/**
 * Checks a purchase list response and pulls out the order IDs.
 *
 * Only Total and ID are checked, because they are the only values this application
 * reads. Entries without a usable ID are counted rather than thrown, so one bad record
 * does not cost the other 99 on the page.
 *
 * @param body - the decoded response body
 * @returns The total across all pages, the IDs on this page, and how many were skipped.
 * @throws DearApiError if the envelope is not the shape the endpoint documents.
 */
function readListPage(body: unknown): ListPage {
  if (typeof body !== 'object' || body === null) {
    throw new DearApiError('Purchase list response was not an object')
  }

  const { Total, PurchaseList } = body as { Total?: unknown; PurchaseList?: unknown }

  if (typeof Total !== 'number' || !Number.isFinite(Total)) {
    throw new DearApiError(`Purchase list response had no usable Total, got: ${String(Total)}`)
  }
  if (!Array.isArray(PurchaseList)) {
    throw new DearApiError('Purchase list response had no PurchaseList array')
  }

  const ids: string[] = []
  let skipped = 0

  for (const entry of PurchaseList) {
    const id =
      typeof entry === 'object' && entry !== null ? (entry as { ID?: unknown }).ID : undefined

    if (typeof id === 'string' && id.length > 0) ids.push(id)
    else skipped++
  }

  return { total: Total, ids, skipped }
}

/**
 * Yields purchase order IDs one page at a time.
 *
 * This stays a generator function rather than becoming an iterator class: an async
 * generator is the compiler writing the iterator class, and hand-rolling next() state
 * is the work the syntax exists to remove. Paging is handled here rather than by the
 * caller, and pages are never collected into an array, so memory does not grow with the
 * size of the result set beyond the set of IDs kept for de-duplication.
 *
 * @param client - API client used to fetch each page
 * @param options - date filter, page size, optional status and search, optional cancel
 * signal
 * @returns An async generator of unique purchase order IDs.
 * @throws DearApiError if a page request fails or the envelope is wrong.
 */
export async function* listPurchaseOrders(
  client: ApiReader,
  options: FetchOptions,
): AsyncGenerator<string> {
  const dateFilter = options.dateFilter ?? 'UpdatedSince'
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
  const logger = options.logger ?? console
  const yielded = new Set<string>()
  let page = 1
  let seen = 0
  let total = Number.POSITIVE_INFINITY

  while (seen < total) {
    const {
      total: reported,
      ids,
      skipped,
    } = await client.get(
      {
        path: PURCHASE_LIST_PATH,
        query: {
          [dateFilter]: options.since.toISOString(),
          Page: page,
          Limit: pageSize,
          Status: options.status,
          Search: options.search,
        },
        signal: options.signal,
      },
      readListPage,
    )
    total = reported

    if (skipped > 0) {
      logger.warn(`Skipped ${skipped} entries with no usable ID on page ${page}`)
    }

    // Stop on an empty page whatever Total says, so an overstated Total cannot turn
    // into an endless loop.
    if (ids.length + skipped === 0) break

    for (const id of ids) {
      // A record updated mid-run can shift between pages and be listed twice. The
      // second sighting is dropped so the order is neither counted nor written twice.
      if (yielded.has(id)) continue
      yielded.add(id)
      yield id
    }

    // Skipped records count too, otherwise paging stalls on a page containing one.
    seen += ids.length + skipped
    page++
  }
}

/**
 * Fetches every matching order and writes each one out.
 *
 * Detail requests run a few at a time rather than all at once, because the API allows
 * 60 calls per minute and this makes one call per order. The run's tallies live inside
 * run() rather than on the instance, so one fetcher can be reused and two runs can
 * never share state.
 */
export class PurchaseOrderFetcher {
  private readonly client: ApiReader
  private readonly writer: OrderWriter
  private readonly options: FetchOptions
  private readonly logger: Logger
  private readonly maxConcurrency: number

  /**
   * @param client - API client used for both the list and the detail requests
   * @param writer - receives each fetched order
   * @param options - filters plus page size, concurrency, cancel signal and logger
   */
  constructor(client: ApiReader, writer: OrderWriter, options: FetchOptions) {
    this.client = client
    this.writer = writer
    this.options = options
    this.logger = options.logger ?? console
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY
  }

  /**
   * Runs one complete fetch.
   *
   * @returns A summary of how many orders were listed, written and failed.
   * @throws DearApiError if listing fails. Failures on single orders are recorded
   * instead.
   */
  async run(): Promise<FetchSummary> {
    const summary: FetchSummary = { listed: 0, succeeded: 0, failedCount: 0, failures: [] }

    // Holding at most maxConcurrency promises caps both the requests in flight and the
    // memory used to track them, so a run over a large account stays flat.
    const pending = new Set<Promise<void>>()

    for await (const id of listPurchaseOrders(this.client, this.options)) {
      summary.listed++

      const task: Promise<void> = this.processOne(id, summary).finally(() => {
        pending.delete(task)
      })
      pending.add(task)

      // processOne never rejects, so neither of these can reject either.
      if (pending.size >= this.maxConcurrency) await Promise.race(pending)
    }

    await Promise.all(pending)

    return summary
  }

  /**
   * Fetches one order and writes it, recording any failure.
   *
   * This never rejects. A single bad order is reported and stepped over so the rest of
   * the run continues.
   *
   * @param id - the purchase order to fetch
   * @param summary - the running tallies to update in place
   * @returns Nothing. Updates the summary in place.
   */
  private async processOne(id: string, summary: FetchSummary): Promise<void> {
    try {
      // The payload is written exactly as it arrived, because the files are the
      // product. It is parsed once, only to reject a body that is not JSON at all.
      const detail = await this.client.getText({
        path: PURCHASE_PATH,
        query: { ID: id },
        signal: this.options.signal,
      })
      try {
        JSON.parse(detail)
      } catch {
        throw new DearApiError(`Purchase order ${id} response was not valid JSON`)
      }
      await this.writer.write(id, detail)
      summary.succeeded++
    } catch (error) {
      summary.failedCount++
      const message = error instanceof Error ? error.message : String(error)
      if (summary.failures.length < MAX_RECORDED_FAILURES) {
        summary.failures.push({ id, error: message })
      }
      this.logger.error(`Unable to extract purchase order ${id}: ${message}`)
    }
  }
}
