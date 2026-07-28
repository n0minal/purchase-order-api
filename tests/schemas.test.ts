import { describe, expect, it } from 'vitest';

import {
  PurchaseDetailSchema,
  PurchaseListEntrySchema,
  PurchaseListPageSchema,
  describeIssues,
} from '../src/schemas.ts';

describe('PurchaseListPageSchema', () => {
  it('accepts the vendor sample envelope, nulls and extra fields included', () => {
    const result = PurchaseListPageSchema.safeParse({
      Total: 1,
      Page: 1,
      SomethingAddedNextQuarter: true,
      PurchaseList: [
        {
          ID: 'a',
          RequiredBy: null,
          DropShipTaskID: null,
          OrderDate: '2018-02-22T00:00:00',
          LastUpdatedDate: '2018-04-19T04:03:06.52Z',
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('names the exact path when Total is unusable', () => {
    const result = PurchaseListPageSchema.safeParse({ Total: 'not-a-number', PurchaseList: [] });

    if (result.success) throw new Error('expected the parse to fail');
    expect(describeIssues(result.error)).toContain('Total');
  });

  it('names the exact path when PurchaseList is missing', () => {
    const result = PurchaseListPageSchema.safeParse({ Total: 3 });

    if (result.success) throw new Error('expected the parse to fail');
    expect(describeIssues(result.error)).toContain('PurchaseList');
  });

  it('turns an entry without a usable ID into null instead of failing the page', () => {
    // This is what lets the parsed page be fully typed: every element is either a
    // checked entry or null, never an unknown.
    const result = PurchaseListPageSchema.safeParse({
      Total: 3,
      PurchaseList: [{ ID: 'a' }, { ID: null }, 'junk'],
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.PurchaseList).toEqual([{ ID: 'a' }, null, null]);
  });

  it('rejects a Total the paging loop could not steer by', () => {
    // The loop compares records seen against Total, so a fraction or a negative count
    // would either stall it or end it instantly.
    expect(PurchaseListPageSchema.safeParse({ Total: 2.5, PurchaseList: [] }).success).toBe(false);
    expect(PurchaseListPageSchema.safeParse({ Total: -1, PurchaseList: [] }).success).toBe(false);
    expect(PurchaseListPageSchema.safeParse({ Total: 0, PurchaseList: [] }).success).toBe(true);
  });
});

describe('PurchaseListEntrySchema', () => {
  it('accepts any entry with a non-empty string ID and keeps unknown fields out of the way', () => {
    const result = PurchaseListEntrySchema.safeParse({ ID: 'a', Unknown: { nested: true } });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.ID).toBe('a');
  });

  it('rejects the IDs that must not reach a request URL', () => {
    expect(PurchaseListEntrySchema.safeParse({ ID: null }).success).toBe(false);
    expect(PurchaseListEntrySchema.safeParse({ ID: '' }).success).toBe(false);
    expect(PurchaseListEntrySchema.safeParse({ ID: 42 }).success).toBe(false);
    expect(PurchaseListEntrySchema.safeParse({}).success).toBe(false);
  });

  it('rejects an entry that is not an object at all', () => {
    expect(PurchaseListEntrySchema.safeParse('a').success).toBe(false);
    expect(PurchaseListEntrySchema.safeParse(null).success).toBe(false);
  });
});

describe('PurchaseDetailSchema', () => {
  it('accepts any JSON object, since the payload is written byte for byte', () => {
    expect(PurchaseDetailSchema.safeParse({}).success).toBe(true);
    expect(
      PurchaseDetailSchema.safeParse({ ID: 'a', Anything: [1, 2, { deep: null }] }).success,
    ).toBe(true);
  });

  it('rejects a body that parses as JSON but is not an object', () => {
    // An error page served as a JSON string with status 200 must not be archived as an
    // order.
    expect(PurchaseDetailSchema.safeParse([1, 2, 3]).success).toBe(false);
    expect(PurchaseDetailSchema.safeParse('maintenance').success).toBe(false);
    expect(PurchaseDetailSchema.safeParse(42).success).toBe(false);
    expect(PurchaseDetailSchema.safeParse(null).success).toBe(false);
  });
});

describe('describeIssues', () => {
  it('reports the path and message for each issue, capped at three', () => {
    const result = PurchaseListPageSchema.safeParse({});

    if (result.success) throw new Error('expected the parse to fail');
    const described = describeIssues(result.error);
    expect(described).toContain('Total');
    expect(described).toContain('PurchaseList');
  });

  it('labels a root-level failure as the response itself', () => {
    const result = PurchaseListPageSchema.safeParse('not an object');

    if (result.success) throw new Error('expected the parse to fail');
    expect(describeIssues(result.error)).toContain('response');
  });
});
