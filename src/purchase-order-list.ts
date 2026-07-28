import { DEFAULT_PAGE_SIZE, PURCHASE_LIST_PATH } from './constants.ts'
import { DearApiError } from './errors.ts'
import { PurchaseListEntrySchema, PurchaseListPageSchema, describeIssues } from './schemas.ts'
import type { ApiReader, FetchOptions } from './types.ts'

/** One page of the purchase list, reduced to what this application uses. */
interface ListPage {
  total: number
  ids: string[]
  /** Entries with no usable ID. Counted so paging does not stall on them. */
  skipped: number
}

/**
 * Checks a purchase list response against the schemas and pulls out the order IDs.
 *
 * Only Total and ID are validated strictly, because they are the only values this
 * application reads; the schemas stay loose about everything else. Entries without a
 * usable ID are counted rather than thrown, so one bad record does not cost the other
 * 99 on the page.
 *
 * @param body - the decoded response body
 * @returns The total across all pages, the IDs on this page, and how many were skipped.
 * @throws DearApiError naming the failed paths, if the envelope does not match.
 */
function readListPage(body: unknown): ListPage {
  const page = PurchaseListPageSchema.safeParse(body)
  if (!page.success) {
    throw new DearApiError(`Purchase list response failed validation: ${describeIssues(page.error)}`)
  }

  const ids: string[] = []
  let skipped = 0

  for (const entry of page.data.PurchaseList) {
    const usable = PurchaseListEntrySchema.safeParse(entry)
    if (usable.success) ids.push(usable.data.ID)
    else skipped++
  }

  return { total: page.data.Total, ids, skipped }
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
