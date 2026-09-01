import { describe, it, expect, vi, beforeEach } from 'vitest'

const users: Record<string, Record<string, unknown> | undefined> = {}
const listings: Record<string, Record<string, unknown> | undefined> = {}
const idempotency: Record<string, Record<string, unknown> | undefined> = {}
const invoices: Record<string, Record<string, unknown>> = {}
const listingUpdates: { id: string; data: Record<string, unknown> }[] = []
let invoiceCounter = 0

vi.mock('../../payments/initiateDeposit', () => ({
  getUsdToCdf: vi.fn(async () => 2800),
}))

function makeDocRef(collectionName: string, id: string) {
  return {
    id,
    ref: { id },
    get: async () => {
      const store = collectionName === 'users' ? users : collectionName === 'product_listings' ? listings : idempotency;
      const data = store[id];
      return { exists: data !== undefined, data: () => data, ref: { id } };
    },
  };
}

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => ({
      doc: (id?: string) => {
        if (name === 'external_invoices' && id === undefined) {
          const newId = `inv${++invoiceCounter}`;
          return { id: newId };
        }
        return makeDocRef(name, id!);
      },
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        set: (ref: { id: string }, data: Record<string, unknown>) => {
          if ('externalInvoiceId' in data) invoices[ref.id] = data;
          else idempotency[ref.id] = data;
        },
        update: (ref: { id: string }, data: Record<string, unknown>) => {
          listingUpdates.push({ id: ref.id, data });
          listings[ref.id] = { ...(listings[ref.id] ?? {}), ...data };
        },
      };
      await fn(tx);
    },
  },
  admin: {
    firestore: Object.assign(() => ({}), {
      FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' },
      Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) },
    }),
  },
  functions: {
    region: vi.fn(() => ({ https: { onCall: vi.fn((h: unknown) => h) } })),
    https: { HttpsError: class extends Error { constructor(public code: string, msg: string) { super(msg) } } },
    logger: { info: vi.fn() },
  },
}))

import { adminCreateAssistedInvoice } from '../adminCreateAssistedInvoice'

type Handler = (data: unknown, context: { auth?: { uid: string } }) => Promise<{ invoiceId: string; amountUsd: number }>
const call = adminCreateAssistedInvoice as unknown as Handler

const VALID_INPUT = {
  clientRequestId: 'req1',
  farmerId: 'farmer1',
  merchantId: 'merchant1',
  listingId: 'listing1',
  quantityKg: 100,
  consentMethod: 'phone' as const,
  consentAt: '2026-09-01T10:00:00.000Z',
};

describe('adminCreateAssistedInvoice', () => {
  beforeEach(() => {
    invoiceCounter = 0;
    listingUpdates.length = 0;
    for (const store of [users, listings, idempotency]) for (const k of Object.keys(store)) delete store[k];
    for (const k of Object.keys(invoices)) delete invoices[k];

    users['admin1'] = { role: 'admin' };
    users['farmer1'] = { role: 'farmer', kycStatus: 'approved' };
    users['merchant1'] = { role: 'merchant', kycStatus: 'approved' };
    listings['listing1'] = { sellerId: 'farmer1', status: 'active', quantityKg: 500, pricePerKgCdf: 2800 };
  });

  it('rejects a non-admin caller', async () => {
    users['u1'] = { role: 'farmer' };
    await expect(call(VALID_INPUT, { auth: { uid: 'u1' } })).rejects.toThrow('Admin only');
  });

  it('rejects a farmer without approved KYC', async () => {
    users['farmer1'] = { role: 'farmer', kycStatus: 'pending' };
    await expect(call(VALID_INPUT, { auth: { uid: 'admin1' } })).rejects.toThrow('KYC approuvé');
  });

  it('rejects a merchant without approved KYC', async () => {
    users['merchant1'] = { role: 'merchant', kycStatus: 'pending' };
    await expect(call(VALID_INPUT, { auth: { uid: 'admin1' } })).rejects.toThrow('KYC approuvé');
  });

  it('rejects a listing that does not belong to the selected farmer', async () => {
    listings['listing1'] = { ...listings['listing1'], sellerId: 'someone-else' };
    await expect(call(VALID_INPUT, { auth: { uid: 'admin1' } })).rejects.toThrow("ne correspond pas");
  });

  it('rejects a listing that is no longer active', async () => {
    listings['listing1'] = { ...listings['listing1'], status: 'sold' };
    await expect(call(VALID_INPUT, { auth: { uid: 'admin1' } })).rejects.toThrow("n'est plus disponible");
  });

  it('rejects a quantity greater than what the listing has available', async () => {
    await expect(call({ ...VALID_INPUT, quantityKg: 1000 }, { auth: { uid: 'admin1' } })).rejects.toThrow('Quantité supérieure');
  });

  it('computes amountUsd server-side from the listing price, never trusting a client-supplied total', async () => {
    const result = await call(VALID_INPUT, { auth: { uid: 'admin1' } });
    // 100kg * 2800 CDF/kg = 280,000 CDF / 2800 (rate) = 100 USD
    expect(result.amountUsd).toBe(100);
    expect(invoices[result.invoiceId]).toMatchObject({
      origin: 'admin_assisted', farmerId: 'farmer1', merchantId: 'merchant1', listingId: 'listing1',
      amountUsd: 100, status: 'pending', partnerId: null, offerId: null,
    });
  });

  it('records consent method, actor and note on the invoice', async () => {
    const result = await call({ ...VALID_INPUT, note: 'Confirmé par téléphone ce matin' }, { auth: { uid: 'admin1' } });
    expect(invoices[result.invoiceId].adminAssisted).toMatchObject({
      actorUid: 'admin1', consentMethod: 'phone', note: 'Confirmé par téléphone ce matin',
    });
  });

  it('closes the listing on invoice creation, matching selectHarvestOffer\'s no-partial-fulfillment convention', async () => {
    await call(VALID_INPUT, { auth: { uid: 'admin1' } });
    expect(listingUpdates).toContainEqual({ id: 'listing1', data: { status: 'sold' } });
  });

  it('is idempotent — a retried call with the same clientRequestId returns the original result without creating a second invoice', async () => {
    const first = await call(VALID_INPUT, { auth: { uid: 'admin1' } });
    const invoiceCountAfterFirst = Object.keys(invoices).length;
    const second = await call(VALID_INPUT, { auth: { uid: 'admin1' } });
    expect(second).toEqual(first);
    expect(Object.keys(invoices).length).toBe(invoiceCountAfterFirst);
  });
});
