import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../verifyPawapayCallbackSignature', () => ({
  verifyPawapayCallbackSignature: vi.fn(async () => true),
}))

const refunds: Record<string, Record<string, unknown> | undefined> = {}
const deposits: Record<string, Record<string, unknown> | undefined> = {}
const users: Record<string, Record<string, unknown> | undefined> = {}
const transactions: Record<string, unknown>[] = []

function applyIncrement(existing: Record<string, unknown> | undefined, patch: Record<string, unknown>) {
  const next = { ...(existing ?? {}) }
  for (const [k, v] of Object.entries(patch)) {
    const inc = v as { __increment?: number }
    next[k] = typeof inc?.__increment === 'number' ? ((next[k] as number) ?? 0) + inc.__increment : v
  }
  return next
}

vi.mock('../../lib/admin', () => ({
  admin: { firestore: { FieldValue: { increment: (n: number) => ({ __increment: n }), serverTimestamp: () => 'SERVER_TIMESTAMP' } } },
  db: {
    collection: (name: string) => {
      if (name === 'refunds') {
        return {
          doc: (id: string) => ({
            collection: 'refunds' as const,
            id,
            get: async () => ({ exists: refunds[id] !== undefined, data: () => refunds[id] }),
            set: async (data: Record<string, unknown>) => { refunds[id] = data },
          }),
        }
      }
      if (name === 'deposits') {
        return { doc: (id: string) => ({ get: async () => ({ exists: deposits[id] !== undefined, data: () => deposits[id] }) }) }
      }
      if (name === 'users') return { doc: (id: string) => ({ collection: 'users' as const, id }) }
      if (name === 'transactions') return { doc: () => ({ collection: 'transactions' as const, id: `tx${transactions.length + 1}` }) }
      throw new Error(`unexpected collection ${name}`)
    },
    runTransaction: async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        update: (ref: { collection: string; id: string }, data: Record<string, unknown>) => {
          if (ref.collection === 'users') users[ref.id] = applyIncrement(users[ref.id], data)
          else throw new Error(`unexpected tx.update on ${ref.collection}`)
        },
        set: (ref: { collection: string; id: string }, data: Record<string, unknown>) => {
          if (ref.collection === 'refunds') refunds[ref.id] = data
          else transactions.push(data)
        },
      }
      await fn(tx)
    },
  },
  functions: {
    region: vi.fn(() => ({ https: { onRequest: vi.fn((h: unknown) => h) } })),
    logger: { error: vi.fn() },
  },
}))

import { pawapayRefundWebhook } from '../pawapayRefundWebhook'

type Handler = (req: unknown, res: unknown) => Promise<void>

function fakeRes() {
  return { statusCode: 0, body: undefined as unknown, status(c: number) { this.statusCode = c; return this }, send(b: unknown) { this.body = b } }
}

function fakeReq(refundId: string, depositId: string, status: string) {
  return {
    method: 'POST',
    path: '/pawapayRefundWebhook',
    headers: { host: 'x' },
    body: { refundId, depositId, status },
    rawBody: Buffer.from('{}'),
  }
}

describe('pawapayRefundWebhook — idempotent under a legitimate PawaPay retry', () => {
  beforeEach(() => {
    for (const k of Object.keys(refunds)) delete refunds[k]
    for (const k of Object.keys(deposits)) delete deposits[k]
    for (const k of Object.keys(users)) delete users[k]
    transactions.length = 0
  })

  it('does not double-debit the wallet on a retried COMPLETED refund webhook', async () => {
    deposits.dep1 = { userId: 'u1', amountUsd: 40 }
    users.u1 = { walletUsd: 100 }

    await (pawapayRefundWebhook as unknown as Handler)(fakeReq('ref1', 'dep1', 'COMPLETED'), fakeRes())
    expect(users.u1).toMatchObject({ walletUsd: 60 })
    expect(transactions).toHaveLength(1)

    // PawaPay retries the same COMPLETED refund callback a second time.
    await (pawapayRefundWebhook as unknown as Handler)(fakeReq('ref1', 'dep1', 'COMPLETED'), fakeRes())
    expect(users.u1).toMatchObject({ walletUsd: 60 }) // NOT 20
    expect(transactions).toHaveLength(1) // NOT a second duplicate transaction
  })

  it('does not reprocess a retried FAILED refund webhook', async () => {
    deposits.dep2 = { userId: 'u2', amountUsd: 20 }
    users.u2 = { walletUsd: 50 }

    await (pawapayRefundWebhook as unknown as Handler)(fakeReq('ref2', 'dep2', 'FAILED'), fakeRes())
    expect(refunds.ref2).toMatchObject({ status: 'failed' })

    await (pawapayRefundWebhook as unknown as Handler)(fakeReq('ref2', 'dep2', 'FAILED'), fakeRes())
    expect(users.u2).toMatchObject({ walletUsd: 50 }) // untouched either way
    expect(transactions).toHaveLength(0)
  })

  it('processes a fresh refund normally', async () => {
    deposits.dep3 = { userId: 'u3', amountUsd: 15 }
    users.u3 = { walletUsd: 30 }
    const res = fakeRes()
    await (pawapayRefundWebhook as unknown as Handler)(fakeReq('ref3', 'dep3', 'COMPLETED'), res)
    expect(res.statusCode).toBe(200)
    expect(users.u3).toMatchObject({ walletUsd: 15 })
    expect(refunds.ref3).toMatchObject({ status: 'completed' })
  })
})
