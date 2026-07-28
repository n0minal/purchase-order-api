import { parseArgs } from 'node:util';

import { DearApiClient } from './client.ts';
import { loadConfig } from './config.ts';
import { DATE_FILTERS, DEFAULT_LOOKBACK_MS, type DateFilter } from './constants.ts';
import { FileWriter } from './file-writer.ts';
import { PurchaseOrderFetcher } from './purchase-order-fetcher.ts';

/**
 * Entry point. Reads settings and arguments, wires the parts, runs once, reports.
 *
 * @returns Process exit code. 0 if every order was written, 1 if any failed.
 * @throws Error if an argument or a configuration value is invalid.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      since: { type: 'string' },
      'date-filter': { type: 'string', default: 'UpdatedSince' },
      status: { type: 'string' },
      search: { type: 'string' },
    },
  });

  const since = values.since ? new Date(values.since) : new Date(Date.now() - DEFAULT_LOOKBACK_MS);
  if (Number.isNaN(since.getTime())) {
    throw new Error(`--since is not a valid date: ${values.since}`);
  }

  const dateFilter = values['date-filter'] as DateFilter;
  if (!DATE_FILTERS.includes(dateFilter)) {
    throw new Error(`--date-filter must be one of: ${DATE_FILTERS.join(', ')}`);
  }

  const config = loadConfig();

  // Ctrl-C stops the requests in flight instead of leaving the process waiting on them.
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort(new Error('Interrupted')));
  process.once('SIGTERM', () => controller.abort(new Error('Terminated')));

  const fetcher = new PurchaseOrderFetcher(
    new DearApiClient(config),
    new FileWriter(config.outputDir),
    {
      since,
      dateFilter,
      status: values.status,
      search: values.search,
      pageSize: config.pageSize,
      maxConcurrency: config.maxConcurrency,
      signal: controller.signal,
    },
  );

  console.info(
    `Fetching purchase orders with ${dateFilter} since ${since.toISOString()} ` +
      `into ${config.outputDir}`,
  );

  const summary = await fetcher.run();

  console.info(
    `Finished. Listed ${summary.listed}, wrote ${summary.succeeded}, ` +
      `failed ${summary.failedCount}`,
  );

  return summary.failedCount > 0 ? 1 : 0;
}

// Only run when this file is the program being executed, so importing this module can
// never start a real run.
if (import.meta.main) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
