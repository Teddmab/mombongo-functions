import { describe, it, expect, vi, beforeEach } from 'vitest'

const users: Record<string, { role?: string } | undefined> = {}
const transactions: Record<string, Record<string, unknown> | undefined> = {}
const updates: Record<string, unknown>[] = []

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const store = name === 'users' ? users : transactions
          return { exists: store[id] !== undefined, data: () => store[id] }
        },
        update: (data: Record<string, unknown>) => { updates.push({ id, ...data }) },
      }),
    }),
  },
  admin: { firestore: Object.assign(() => ({}), { FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' } }) },
  functions: {
    region: vi.fn(() => ({ https: { onCall: vi.fn((h: unknown) => h) } })),
    https: { HttpsError: class extends Error { constructor(public code: string, msg: string) { super(msg) } } },
    logger: { info: vi.fn() },
  },
}))

import { resolveReconciliationException } from '../resolveReconciliationException'

type Handler = (data: unknown, context: { auth?: { uid: string } }) => Promise<unknown>
const call = resolveReconciliationException as unknown as Handler

describe('resolveReconciliationException', () => {
  beforeEach(() => {
    updates.length = 0
    for (const store of [users, transactions]) for (const k of Object.keys(store)) delete store[k]
    users['admin1'] = { role: 'admin' }
    transactions['tx1'] = { reconciliationStatus: 'exception' }
  })

  it('rejects a non-admin caller', async () => {
    users['u1'] = { role: 'farmer' }
    await expect(call({ transactionId: 'tx1', note: 'ok' }, { auth: { uid: 'u1' } })).rejects.toThrow('Admin only')
  });

  it('requires a note', async () => {
    await expect(call({ transactionId: 'tx1' }, { auth: { uid: 'admin1' } })).rejects.toThrow('note required')
  });

  it('refuses to resolve a transaction with no active exception', async () => {
    transactions['tx1'] = { reconciliationStatus: 'matched' }
    await expect(call({ transactionId: 'tx1', note: 'ok' }, { auth: { uid: 'admin1' } })).rejects.toThrow("pas d'exception");
  });

  it('resolves the exception and records the admin + note', async () => {
    const result = await call({ transactionId: 'tx1', note: 'Vérifié manuellement avec le partenaire' }, { auth: { uid: 'admin1' } });
    expect(result).toEqual({ success: true });
    expect(updates).toContainEqual({
      id: 'tx1',
      reconciliationStatus: 'resolved_manually',
      reconciliationResolvedBy: 'admin1',
      reconciliationResolvedAt: 'SERVER_TIMESTAMP',
      reconciliationResolutionNote: 'Vérifié manuellement avec le partenaire',
    });
  });
});
