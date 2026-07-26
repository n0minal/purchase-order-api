/**
 * Values shared between modules, and the fixed sets that would be enums if type
 * stripping allowed them. Knobs owned by a single class, such as the retry policy's
 * backoff numbers, stay next to their owner instead of here.
 */

/** The paged list of purchase orders. */
export const PURCHASE_LIST_PATH = '/ExternalApi/v2/purchaseList'

/**
 * The full record for one purchase order.
 *
 * The docs mark this endpoint deprecated. It states that it "supports only Simple
 * Purchases" and points to /advanced-purchase instead. It is kept because switching
 * changes which orders can be fetched at all, which is a product decision rather than a
 * refactor.
 */
export const PURCHASE_PATH = '/ExternalApi/v2/purchase'

/**
 * Which timestamp the list is filtered on.
 *
 * /purchaseList accepts only these two. Unrecognised parameters are ignored rather than
 * rejected, so a misspelt filter would silently fetch the whole account history.
 */
export const DATE_FILTERS = ['UpdatedSince', 'UpdatedUntil'] as const
export type DateFilter = (typeof DATE_FILTERS)[number]

/** Page size used when options do not give one. Matches the documented default. */
export const DEFAULT_PAGE_SIZE = 100

/** Detail requests in flight at once when options do not give a limit. */
export const DEFAULT_MAX_CONCURRENCY = 4

/** Failure details stop being stored past this point, so an outage cannot fill memory. */
export const MAX_RECORDED_FAILURES = 100

/** How far back to look when --since is not given. Thirty days. */
export const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000
