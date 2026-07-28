import { z } from 'zod'

/**
 * Zod schemas for the two responses the run depends on.
 *
 * The rule stays the same as before zod: validate what is used, stay loose about the
 * rest. Strictness lives on Total and ID, because paging and every detail request
 * depend on them. Everything else passes through unmodelled, because the vendor sends
 * null in documented-required fields, mixes two date formats, and adds fields without
 * notice — see docs/api-notes.md — and none of that may fail a run.
 */

/** The list envelope. Loose, so vendor additions never fail a page. */
export const PurchaseListPageSchema = z.looseObject({
  /** Count across all pages. The paging loop steers by it, so it must be a whole number. */
  Total: z.int().nonnegative(),
  /** Entries are validated one at a time, so one bad record cannot cost the page. */
  PurchaseList: z.array(z.unknown()),
})

/**
 * One usable list entry: anything carrying a non-empty string ID. Checked entry by
 * entry with safeParse, so a bad entry is counted and skipped rather than thrown.
 */
export const PurchaseListEntrySchema = z.looseObject({
  ID: z.string().min(1),
})

/**
 * A detail payload: any JSON object. No fields are modelled on purpose — the payload is
 * written to disk byte for byte, so this schema's only job is rejecting a response that
 * is not an object at all, such as an error string served with status 200.
 */
export const PurchaseDetailSchema = z.looseObject({})

/**
 * Turns a zod error into one log-sized line naming the paths that failed.
 *
 * @param error - the error from a failed parse
 * @returns Up to three issues as "path: message", joined with semicolons.
 */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join('.') : 'response'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}
