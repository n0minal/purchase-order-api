import { describe, expect, it } from 'vitest';

import { listPurchaseOrders } from '../src/purchase-order-list.ts';
import {
  baseFetchOptions,
  isPurchaseListRequest,
  jsonResponse,
  purchaseListPageResponse,
  stubFetch,
  testClient,
} from './helpers.ts';

describe('listPurchaseOrders', () => {
  it('stops on an empty page even when Total overstates the result set', async () => {
    const { fetch } = stubFetch((url) => {
      if (!isPurchaseListRequest(url)) return jsonResponse({});
      const page = Number(url.searchParams.get('Page'));
      return page === 1
        ? purchaseListPageResponse(['a'], 9_999)
        : purchaseListPageResponse([], 9_999);
    });

    const ids = [];
    for await (const id of listPurchaseOrders(
      testClient(fetch),
      baseFetchOptions({ pageSize: 2 }),
    )) {
      ids.push(id);
    }

    expect(ids).toEqual(['a']);
  });

  it('keeps paging when a whole page holds nothing usable', async () => {
    // Skipped records still count towards the total. If they did not, paging would ask
    // for the same page forever.
    const { fetch } = stubFetch((url) => {
      if (!isPurchaseListRequest(url)) return jsonResponse({ ID: 'x' });
      const page = Number(url.searchParams.get('Page'));
      if (page === 1) return jsonResponse({ Total: 3, PurchaseList: [{ ID: null }, {}] });
      return purchaseListPageResponse(['c'], 3);
    });

    const ids = [];
    for await (const id of listPurchaseOrders(
      testClient(fetch),
      baseFetchOptions({ pageSize: 2 }),
    )) {
      ids.push(id);
    }

    expect(ids).toEqual(['c']);
  });
});
