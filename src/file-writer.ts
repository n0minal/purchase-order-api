import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { OrderWriter } from './types.ts';

/**
 * Turns an order ID into something safe to use as a filename, so an ID holding ".." or
 * a path separator cannot write outside the target folder.
 *
 * @param id - the purchase order ID as it came back from the API
 * @returns A string of letters, digits, dots, dashes and underscores only.
 */
export function safeFileName(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, '_');
  return /^\.+$/.test(cleaned) ? '_' : cleaned;
}

/**
 * Writes each order to its own file in one directory.
 *
 * The directory is created on first use and only once, however many writes overlap.
 * Each write goes to a temporary file and is renamed into place, so an interrupted run
 * leaves a stray temp file rather than a half written .json that looks complete. The
 * temporary name carries the process ID and a per-writer sequence number, so no two
 * writes can ever share one.
 */
export class FileWriter implements OrderWriter {
  private readonly directory: string;
  private directoryReady: Promise<void> | undefined;
  private sequence = 0;

  /**
   * @param directory - where the files go. Created on the first write.
   */
  constructor(directory: string) {
    this.directory = directory;
  }

  /**
   * Writes one order atomically.
   *
   * @param id - the purchase order ID, sanitised before it becomes a filename
   * @param contents - the payload, written exactly as given
   * @returns Resolves once the file is in place under its final name.
   */
  async write(id: string, contents: string): Promise<void> {
    this.directoryReady ??= mkdir(this.directory, { recursive: true }).then(() => undefined);
    await this.directoryReady;

    const target = join(this.directory, `purchaseorder_${safeFileName(id)}.json`);
    const temporary = `${target}.${process.pid}.${this.sequence++}.tmp`;

    await writeFile(temporary, contents, 'utf8');
    await rename(temporary, target);
  }
}
