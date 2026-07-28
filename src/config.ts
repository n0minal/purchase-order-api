import type { Config } from './types.ts';

/**
 * Reads a required setting, failing if it is missing or empty.
 *
 * @param environment - the environment to read from
 * @param key - name of the environment variable
 * @returns The value.
 * @throws Error naming the variable, if it is absent.
 */
function requireSetting(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key];
  if (!value) throw new Error(`Missing environment variable ${key}. See .env.example.`);
  return value;
}

/**
 * Reads an optional whole number setting.
 *
 * @param environment - the environment to read from
 * @param key - name of the environment variable
 * @param fallback - value to use when the variable is not set
 * @param minimum - smallest acceptable value
 * @returns The parsed number, or the fallback.
 * @throws Error if the variable is set to something that is not a whole number of at
 * least the minimum.
 */
function wholeNumberSetting(
  environment: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  minimum = 1,
): number {
  const raw = environment[key];
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${key} must be a whole number of at least ${minimum}, got: ${raw}`);
  }
  return value;
}

/**
 * Reads settings from the environment and checks them before use.
 *
 * Everything is validated once, at startup, so a missing credential fails straight away
 * instead of showing up later as a 403 partway through a run.
 *
 * @param environment - the environment to read from. Defaults to process.env.
 * @returns A complete Config.
 * @throws Error naming the first setting that is missing or invalid.
 */
export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  return {
    baseUrl: requireSetting(environment, 'DEAR_BASE_URL'),
    accountId: requireSetting(environment, 'DEAR_ACCOUNT_ID'),
    applicationKey: requireSetting(environment, 'DEAR_APPLICATION_KEY'),
    outputDir: requireSetting(environment, 'OUTPUT_DIR'),
    // Concurrency caps how many requests are in flight and the memory used to track
    // them. The pace of calls is governed separately by callsPerMinute.
    maxConcurrency: wholeNumberSetting(environment, 'MAX_CONCURRENCY', 4),
    pageSize: wholeNumberSetting(environment, 'PAGE_SIZE', 100),
    callsPerMinute: wholeNumberSetting(environment, 'CALLS_PER_MINUTE', 60),
    requestTimeoutMs: wholeNumberSetting(environment, 'REQUEST_TIMEOUT_MS', 30_000),
    maxRetries: wholeNumberSetting(environment, 'MAX_RETRIES', 3, 0),
  };
}
