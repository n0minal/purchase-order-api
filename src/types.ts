/**
 * Interfaces and type aliases shared between modules.
 *
 * Types used by a single module, such as the shape of one parsed list page, stay next
 * to their only user instead of here.
 */

import type { DateFilter } from './constants.ts';

/** Settings the application runs with. */
export interface Config {
  baseUrl: string;
  accountId: string;
  applicationKey: string;
  outputDir: string;
  /** How many detail requests may be in flight at once. */
  maxConcurrency: number;
  /** How many records to ask for per page. The documented default is 100. */
  pageSize: number;
  /** Client-side request budget. The documented API limit is 60 calls per minute. */
  callsPerMinute: number;
  requestTimeoutMs: number;
  /** Attempts after the first one. Zero means one attempt with no retries. */
  maxRetries: number;
}

/**
 * Where progress and failure messages go. `console` satisfies it, and tests pass a
 * silent implementation so expected retries and failures do not bury the test report.
 */
export interface Logger {
  warn(message: string): void;
  error(message: string): void;
}

/** Everything needed to make one GET request. */
export interface RequestOptions {
  path: string;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
}

/**
 * Any value JSON.parse can produce.
 *
 * Response bodies reach readers as this type rather than as unknown. It is exactly as
 * safe, because property access still requires narrowing, and it states the one thing
 * that is known about the value: it is JSON whose shape nothing has checked yet.
 */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * What the fetch loop needs from an API client.
 *
 * Depending on this instead of on DearApiClient keeps the rule in one direction: the
 * policy says what it needs, and the transport happens to provide it. It also makes
 * substitution possible at all. DearApiClient has private fields, which makes it
 * nominally typed, so a stand-in that matches its public shape is still rejected unless
 * it extends the class.
 */
export interface ApiReader {
  get<T>(options: RequestOptions, read: (body: JsonValue) => T): Promise<T>;
  getText(options: RequestOptions): Promise<string>;
}

/**
 * Where each fetched order is sent. FileWriter is the production implementation; tests
 * pass an object literal that keeps orders in a Map.
 */
export interface OrderWriter {
  write(id: string, contents: string): Promise<void>;
}

/** Filters, tuning and reporting for a run. */
export interface FetchOptions {
  /**
   * Lower bound for the chosen timestamp field. A Date is a fixed point in time, so the
   * value sent is unambiguously UTC.
   */
  since: Date;
  dateFilter?: DateFilter;
  status?: string;
  search?: string;
  /** How many records to ask for per page. The documented default is 100. */
  pageSize?: number;
  /** How many detail requests may be in flight at once. */
  maxConcurrency?: number;
  signal?: AbortSignal;
  /** Where skipped entries and per-order failures are reported. Defaults to console. */
  logger?: Logger;
}

/** What happened during a run. */
export interface FetchSummary {
  listed: number;
  succeeded: number;
  failedCount: number;
  failures: Array<{ id: string; error: string }>;
}
