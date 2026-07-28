import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileWriter, safeFileName } from '../src/file-writer.ts';

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'po-writer-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('safeFileName', () => {
  it('keeps an ordinary order ID unchanged', () => {
    expect(safeFileName('PO-1')).toBe('PO-1');
    expect(safeFileName('a1b2.c3_d4-e5')).toBe('a1b2.c3_d4-e5');
  });

  it('strips the separators that would let an ID write to another directory', () => {
    // An ID is a value from a remote server, so it cannot be trusted as part of a path.
    expect(safeFileName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeFileName('a/b')).toBe('a_b');
    expect(safeFileName('a\\b')).toBe('a_b');
  });

  it('replaces an ID made only of dots, which would name the directory itself', () => {
    expect(safeFileName('.')).toBe('_');
    expect(safeFileName('..')).toBe('_');
    expect(safeFileName('...')).toBe('_');
  });

  it('removes characters that need quoting in a shell or are invalid on Windows', () => {
    expect(safeFileName('a b')).toBe('a_b');
    expect(safeFileName('a:b*c?')).toBe('a_b_c_');
    expect(safeFileName('$(whoami)')).toBe('__whoami_');
  });
});

describe('FileWriter', () => {
  it('writes each order to its own file, named after the ID', async () => {
    const target = join(workspace, 'out');
    const writer = new FileWriter(target);

    await writer.write('PO-1', '{"ID":"PO-1"}');
    await writer.write('PO-2', '{"ID":"PO-2"}');

    expect((await readdir(target)).sort()).toEqual([
      'purchaseorder_PO-1.json',
      'purchaseorder_PO-2.json',
    ]);
    expect(await readFile(join(target, 'purchaseorder_PO-1.json'), 'utf8')).toBe('{"ID":"PO-1"}');
  });

  it('creates the output directory, including missing parents', async () => {
    const target = join(workspace, 'deeply', 'nested', 'out');
    await new FileWriter(target).write('PO-1', '{}');

    expect((await stat(target)).isDirectory()).toBe(true);
  });

  it('creates the directory once even when many writes start at the same time', async () => {
    // The mkdir promise is cached on the instance, so twenty concurrent writes must not
    // race each other.
    const target = join(workspace, 'out');
    const writer = new FileWriter(target);

    await Promise.all(Array.from({ length: 20 }, (_, i) => writer.write(`PO-${i}`, `{"n":${i}}`)));

    expect(await readdir(target)).toHaveLength(20);
  });

  it('leaves no temporary files behind after a successful write', async () => {
    // Each write lands on a temp file first and is renamed into place, so an interrupted
    // run leaves a stray .tmp rather than a half written .json that looks complete.
    const target = join(workspace, 'out');
    await new FileWriter(target).write('PO-1', '{}');

    expect((await readdir(target)).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('keeps concurrent writes to the same ID on separate temp files', async () => {
    // Page drift can hand the run one order twice. The temp name carries a sequence
    // number, so overlapping writes never share a file and the survivor is one whole
    // payload, not an interleaving of two.
    const target = join(workspace, 'out');
    const writer = new FileWriter(target);

    await Promise.all([writer.write('a', '{"v":1}'), writer.write('a', '{"v":2}')]);

    expect(await readdir(target)).toEqual(['purchaseorder_a.json']);
    expect(await readFile(join(target, 'purchaseorder_a.json'), 'utf8')).toMatch(/^\{"v":[12]\}$/);
  });

  it('overwrites a previous run rather than failing on an existing file', async () => {
    const target = join(workspace, 'out');
    const writer = new FileWriter(target);

    await writer.write('PO-1', '{"v":1}');
    await writer.write('PO-1', '{"v":2}');

    expect(await readFile(join(target, 'purchaseorder_PO-1.json'), 'utf8')).toBe('{"v":2}');
  });

  it('keeps a hostile ID inside the output directory', async () => {
    // An ID is a value from a remote server, so it cannot be trusted as part of a path.
    const target = join(workspace, 'out');
    await new FileWriter(target).write('../../escaped', '{}');

    expect(await readdir(target)).toEqual(['purchaseorder_.._.._escaped.json']);
    // Nothing appeared next to the temp workspace, which is where the traversal aimed.
    expect(await readdir(workspace)).toEqual(['out']);
  });

  it('writes UTF-8 content unchanged', async () => {
    const target = join(workspace, 'out');
    const contents = JSON.stringify({ Supplier: 'Café Ñandú 東京', Amount: 12.5 }, null, 2);

    await new FileWriter(target).write('PO-1', contents);

    expect(await readFile(join(target, 'purchaseorder_PO-1.json'), 'utf8')).toBe(contents);
  });
});
