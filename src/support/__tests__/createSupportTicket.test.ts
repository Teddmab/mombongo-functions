import { describe, it, expect, vi, beforeEach } from 'vitest'

const users: Record<string, { role?: string } | undefined> = {}
const transactions: Record<string, Record<string, unknown> | undefined> = {}
const tickets: Record<string, unknown>[] = []

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => {
      if (name === 'users') return { doc: (id: string) => ({ get: async () => ({ data: () => users[id] }) }) }
      if (name === 'transactions') return { doc: (id: string) => ({ get: async () => ({ exists: transactions[id] !== undefined }) }) }
      if (name === 'support_tickets') {
        return {
          add: async (data: Record<string, unknown>) => {
            tickets.push(data)
            return { id: `ticket${tickets.length}` }
          },
        }
      }
      throw new Error(`unexpected collection ${name}`)
    },
  },
  admin: { firestore: Object.assign(() => ({}), { FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' } }) },
  functions: {
    region: vi.fn(() => ({ https: { onCall: vi.fn((h: unknown) => h) } })),
    https: { HttpsError: class extends Error { constructor(public code: string, msg: string) { super(msg) } } },
    logger: { info: vi.fn() },
  },
}))

import { createSupportTicket } from '../createSupportTicket'

type Handler = (data: unknown, context: { auth?: { uid: string } }) => Promise<{ ticketId: string }>
const call = createSupportTicket as unknown as Handler

describe('createSupportTicket', () => {
  beforeEach(() => {
    tickets.length = 0
    for (const store of [users, transactions]) for (const k of Object.keys(store)) delete store[k]
    users['admin1'] = { role: 'admin' }
    transactions['tx1'] = { type: 'deposit' }
  })

  it('rejects a non-admin caller', async () => {
    users['u1'] = { role: 'agent' }
    await expect(call({ transactionId: 'tx1', description: 'x' }, { auth: { uid: 'u1' } })).rejects.toThrow('Admin only')
  })

  it('requires a description', async () => {
    await expect(call({ transactionId: 'tx1' }, { auth: { uid: 'admin1' } })).rejects.toThrow('description required')
  })

  it('404s for a transaction that does not exist', async () => {
    await expect(call({ transactionId: 'ghost', description: 'x' }, { auth: { uid: 'admin1' } })).rejects.toThrow('Transaction not found')
  })

  it('creates a ticket referencing the transaction and the creating admin', async () => {
    const result = await call({ transactionId: 'tx1', description: 'Le client dit ne pas avoir reçu le paiement' }, { auth: { uid: 'admin1' } })
    expect(result).toEqual({ ticketId: 'ticket1' })
    expect(tickets[0]).toMatchObject({
      transactionId: 'tx1',
      description: 'Le client dit ne pas avoir reçu le paiement',
      createdBy: 'admin1',
    })
  })
})
