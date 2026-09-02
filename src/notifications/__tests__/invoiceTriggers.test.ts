import { describe, it, expect, vi, beforeEach } from 'vitest'

const users: Record<string, Record<string, unknown> | undefined> = {}
const notifications: Record<string, Record<string, unknown>> = {}

vi.mock('firebase-admin', () => ({
  apps: [{}], // non-empty so `if (!admin.apps.length) admin.initializeApp()` guards elsewhere are no-ops
  initializeApp: vi.fn(),
  firestore: Object.assign(
    () => ({
      collection: (name: string) => {
        if (name === 'notifications') {
          return {
            doc: (id: string) => ({
              get: async () => ({ exists: notifications[id] !== undefined }),
              set: (data: Record<string, unknown>) => { notifications[id] = data },
            }),
          }
        }
        if (name === 'users') {
          return { doc: (id: string) => ({ get: async () => ({ exists: users[id] !== undefined, data: () => users[id] }) }) }
        }
        throw new Error(`unexpected collection ${name}`)
      },
      runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
          set: (ref: { set: (d: Record<string, unknown>) => void }, data: Record<string, unknown>) => ref.set(data),
        }
        return fn(tx)
      },
    }),
    { FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' } },
  ),
}))

vi.mock('firebase-functions', () => ({
  region: vi.fn(() => ({
    firestore: {
      document: () => ({
        onCreate: (handler: unknown) => handler,
        onUpdate: (handler: unknown) => handler,
      }),
    },
  })),
}))

const { sendPushMock } = vi.hoisted(() => ({ sendPushMock: vi.fn() }))
vi.mock('../sendPush', () => ({ sendPush: sendPushMock }))

import { onExternalInvoiceCreated } from '../invoiceTriggers'

type Snap = { data: () => Record<string, unknown> }
type Handler = (snap: Snap, context: { params: { invoiceId: string } }) => Promise<void>
const trigger = onExternalInvoiceCreated as unknown as Handler

function invoiceSnap(data: Record<string, unknown>): Snap {
  return { data: () => data };
}

describe('onExternalInvoiceCreated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(users)) delete users[k];
    for (const k of Object.keys(notifications)) delete notifications[k];
    users['merchant-1'] = { isApiAccount: false };
  })

  it('notifies the single farmer on a harvest_sale invoice', async () => {
    await trigger(invoiceSnap({ farmerId: 'f1', merchantId: 'merchant-1', amountUsd: 50, commodity: 'Maïs' }), { params: { invoiceId: 'inv1' } });
    expect(notifications['invoice_created_farmer_inv1_f1']).toMatchObject({ userId: 'f1', type: 'invoice_issued' });
  })

  it('notifies every farmer in a cooperative invoice, not just farmers[0]', async () => {
    await trigger(
      invoiceSnap({ farmerId: 'f1', farmers: [{ farmerId: 'f1' }, { farmerId: 'f2' }], merchantId: 'merchant-1', amountUsd: 50, commodity: 'Maïs' }),
      { params: { invoiceId: 'inv1' } },
    );
    expect(notifications['invoice_created_farmer_inv1_f1']).toBeDefined();
    expect(notifications['invoice_created_farmer_inv1_f2']).toBeDefined();
  })

  it('notifies a real, logged-in merchant', async () => {
    await trigger(invoiceSnap({ farmerId: 'f1', merchantId: 'merchant-1', amountUsd: 50, commodity: 'Maïs' }), { params: { invoiceId: 'inv1' } });
    expect(notifications['invoice_created_merchant_inv1']).toMatchObject({ userId: 'merchant-1', type: 'invoice_issued' });
  })

  it('never notifies a partner\'s synthetic merchant account — nobody logs in as it', async () => {
    users['merchant-1'] = { isApiAccount: true };
    await trigger(invoiceSnap({ farmerId: 'f1', merchantId: 'merchant-1', amountUsd: 50, commodity: 'Maïs' }), { params: { invoiceId: 'inv1' } });
    expect(notifications['invoice_created_merchant_inv1']).toBeUndefined();
    expect(notifications['invoice_created_farmer_inv1_f1']).toBeDefined();
  })
})
