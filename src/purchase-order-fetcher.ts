import { DEFAULT_MAX_CONCURRENCY, MAX_RECORDED_FAILURES, PURCHASE_PATH } from './constants.ts';
import { DearApiError } from './errors.ts';
import { listPurchaseOrders } from './purchase-order-list.ts';
import { PurchaseDetailSchema, describeIssues } from './schemas.ts';
import type {
  ApiReader,
  FetchOptions,
  FetchSummary,
  JsonValue,
  Logger,
  OrderWriter,
} from './types.ts';

/**
 * Fetches every matching order and writes each one out.
 *
 * Detail requests run a few at a time rather than all at once, because the API allows
 * 60 calls per minute and this makes one call per order. The run's tallies live inside
 * run() rather than on the instance, so one fetcher can be reused and two runs can
 * never share state.
 */
export class PurchaseOrderFetcher {
  private readonly client: ApiReader;
  private readonly writer: OrderWriter;
  private readonly options: FetchOptions;
  private readonly logger: Logger;
  private readonly maxConcurrency: number;

  /**
   * @param client - API client used for both the list and the detail requests
   * @param writer - receives each fetched order
   * @param options - filters plus page size, concurrency, cancel signal and logger
   */
  constructor(client: ApiReader, writer: OrderWriter, options: FetchOptions) {
    this.client = client;
    this.writer = writer;
    this.options = options;
    this.logger = options.logger ?? console;
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  }

  /**
   * Runs one complete fetch.
   *
   * @returns A summary of how many orders were listed, written and failed.
   * @throws DearApiError if listing fails. Failures on single orders are recorded
   * instead.
   */
  async run(): Promise<FetchSummary> {
    const summary: FetchSummary = { listed: 0, succeeded: 0, failedCount: 0, failures: [] };

    // Holding at most maxConcurrency promises caps both the requests in flight and the
    // memory used to track them, so a run over a large account stays flat.
    const pendingOrderTasks = new Set<Promise<void>>();

    try {
      for await (const id of listPurchaseOrders(this.client, this.options)) {
        summary.listed++;

        const task: Promise<void> = this.processPurchaseOrderById(id, summary).finally(() => {
          pendingOrderTasks.delete(task);
        });
        pendingOrderTasks.add(task);

        // processPurchaseOrderById never rejects, so neither of these can reject either.
        if (pendingOrderTasks.size >= this.maxConcurrency) await Promise.race(pendingOrderTasks);
      }
    } finally {
      await Promise.all(pendingOrderTasks);
    }

    return summary;
  }

  /**
   * Fetches one purchase order by its ID and writes it, recording any failure.
   *
   * This never rejects. A single bad order is reported and stepped over so the rest of
   * the run continues.
   *
   * @param id - the purchase order to fetch
   * @param summary - the running tallies to update in place
   * @returns Nothing. Updates the summary in place.
   */
  private async processPurchaseOrderById(id: string, summary: FetchSummary): Promise<void> {
    try {
      // The payload is written exactly as it arrived, because the files are the
      // product. The parsed copy exists only to be validated and is never written.
      const detail = await this.client.getText({
        path: PURCHASE_PATH,
        query: { ID: id },
        signal: this.options.signal,
      });

      let parsed: JsonValue;
      try {
        parsed = JSON.parse(detail);
      } catch {
        throw new DearApiError(`Purchase order ${id} response was not valid JSON`);
      }
      const checked = PurchaseDetailSchema.safeParse(parsed);
      if (!checked.success) {
        throw new DearApiError(
          `Purchase order ${id} response failed validation: ${describeIssues(checked.error)}`,
        );
      }

      await this.writer.write(id, detail);
      summary.succeeded++;
    } catch (error) {
      summary.failedCount++;
      const message = error instanceof Error ? error.message : String(error);
      if (summary.failures.length < MAX_RECORDED_FAILURES) {
        summary.failures.push({ id, error: message });
      }
      this.logger.error(`Unable to extract purchase order ${id}: ${message}`);
    }
  }
}
