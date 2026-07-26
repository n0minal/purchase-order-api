import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config.ts'

/** The smallest environment that loads. Tests override or remove one key at a time. */
function validEnv(): NodeJS.ProcessEnv {
  return {
    DEAR_BASE_URL: 'https://api.example.test',
    DEAR_ACCOUNT_ID: 'account-1',
    DEAR_APPLICATION_KEY: 'key-1',
    OUTPUT_DIR: './purchase-orders',
  }
}

describe('required settings', () => {
  it('reads every credential from the environment', () => {
    const config = loadConfig(validEnv())

    expect(config.baseUrl).toBe('https://api.example.test')
    expect(config.accountId).toBe('account-1')
    expect(config.applicationKey).toBe('key-1')
    expect(config.outputDir).toBe('./purchase-orders')
  })

  it.each(['DEAR_BASE_URL', 'DEAR_ACCOUNT_ID', 'DEAR_APPLICATION_KEY', 'OUTPUT_DIR'])(
    'fails at startup and names %s when it is missing',
    (key) => {
      const env = validEnv()
      delete env[key]

      // Naming the variable matters. A missing credential otherwise turns up later as a
      // 403 part way through a run, which is much harder to read.
      expect(() => loadConfig(env)).toThrow(key)
    },
  )

  it('treats an empty value as missing rather than passing it to the API', () => {
    expect(() => loadConfig({ ...validEnv(), DEAR_APPLICATION_KEY: '' })).toThrow(
      'DEAR_APPLICATION_KEY',
    )
  })
})

describe('optional numeric settings', () => {
  it('falls back to the documented defaults when nothing is set', () => {
    const config = loadConfig(validEnv())

    expect(config.maxConcurrency).toBe(4)
    // The API documents 100 as the page size default and 60 calls per minute as the limit.
    expect(config.pageSize).toBe(100)
    expect(config.callsPerMinute).toBe(60)
    expect(config.requestTimeoutMs).toBe(30_000)
    expect(config.maxRetries).toBe(3)
  })

  it('reads the values that are set', () => {
    const config = loadConfig({
      ...validEnv(),
      MAX_CONCURRENCY: '8',
      PAGE_SIZE: '50',
      CALLS_PER_MINUTE: '30',
      REQUEST_TIMEOUT_MS: '5000',
      MAX_RETRIES: '1',
    })

    expect(config.maxConcurrency).toBe(8)
    expect(config.pageSize).toBe(50)
    expect(config.callsPerMinute).toBe(30)
    expect(config.requestTimeoutMs).toBe(5_000)
    expect(config.maxRetries).toBe(1)
  })

  it('uses the default when the variable is present but empty', () => {
    expect(loadConfig({ ...validEnv(), MAX_CONCURRENCY: '' }).maxConcurrency).toBe(4)
  })

  it.each(['nope', '0', '-1', '2.5', 'NaN', 'Infinity'])(
    'rejects %s rather than running with a nonsensical value',
    (raw) => {
      // A concurrency of 0 would hang and a negative page size would confuse the API, so
      // these fail loudly at startup instead.
      expect(() => loadConfig({ ...validEnv(), MAX_CONCURRENCY: raw })).toThrow(
        /MAX_CONCURRENCY must be a whole number of at least 1/,
      )
    },
  )
})

describe('maxRetries', () => {
  it('accepts zero, which means one attempt and no retries', () => {
    expect(loadConfig({ ...validEnv(), MAX_RETRIES: '0' }).maxRetries).toBe(0)
  })

  it('still rejects a negative count', () => {
    expect(() => loadConfig({ ...validEnv(), MAX_RETRIES: '-1' })).toThrow(
      /MAX_RETRIES must be a whole number of at least 0/,
    )
  })
})
