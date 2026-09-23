import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../verifyPawapayCallbackSignature', () => ({
  verifyPawapayCallbackSignature: vi.fn(async () => true),
}))

const withdrawals: Record<string, Record<string, unknown> | undefined> = {}
const users: Record<string, Record<string, unknown> | undefined> = {}
const transactions: Record<string, unknown>[] = []

function makeWithdrawRef(id: string) {
  return {
    collection: 'withdrawals' as const,
    id,
    get: async () => ({ exists: withdrawals[id] !== undefined, data: () => withdrawals[id] }),
  }
}

vi.mock('../../lib/admin', () => ({
  admin: { firestore: { FieldValue: { increment: (n: number) => ({ __increment: n }), serverTimestamp: () => 'SERVER_TIMESTAMP' } } },
  db: {
    collection: (name: string) => {
      if (name === 'withdrawals') return { doc: (id: string) => makeWithdrawRef(id) }
      if (name === 'users') return { doc: (id: string) => ({ collection: 'users' as const, id }) }
      if (name === 'transactions') return { doc: () => ({ collection: 'transactions' as const, id: `tx${transactions.length + 1}` }) }
      throw new Error(`unexpected collection ${name}`)
    },
    runTransaction: async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        update: (ref: { collection: string; id: string }, data: Record<string, unknown>) => {
          if (ref.collection === 'withdrawals') withdrawals[ref.id] = { ...withdrawals[ref.id], ...data }
          else if (ref.collection === 'users') users[ref.id] = applyIncrement(users[ref.id], data)
          else throw new Error(`unexpected tx.update on ${ref.collection}`)
        },
        set: (_ref: { collection: string; id: string }, data: Record<string, unknown>) => {
          transactions.push(data)
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

function applyIncrement(existing: Record<string, unknown> | undefined, patch: Record<string, unknown>) {
  const next = { ...(existing ?? {}) }
  for (const [k, v] of Object.entries(patch)) {
    const inc = v as { __increment?: number }
    next[k] = typeof inc?.__increment === 'number' ? ((next[k] as number) ?? 0) + inc.__increment : v
  }
  return next
}

import { pawapayPayoutWebhook } from '../pawapayPayoutWebhook'

type Handler = (req: unknown, res: unknown) => Promise<void>

function fakeRes() {
  return { statusCode: 0, body: undefined as unknown, status(c: number) { this.statusCode = c; return this }, send(b: unknown) { this.body = b } }
}

function fakeReq(payoutId: string, status: string) {
  return {
    method: 'POST',
    path: '/pawapayPayoutWebhook',
    headers: { host: 'x' },
    body: { payoutId, status },
    rawBody: Buffer.from('{}'),
  }
}

describe('pawapayPayoutWebhook — idempotent under a legitimate PawaPay retry', () => {
  beforeEach(() => {
    for (const k of Object.keys(withdrawals)) delete withdrawals[k]
    for (const k of Object.keys(users)) delete users[k]
    transactions.length = 0
  })

  it('does not double-credit the wallet on a retried FAILED payout webhook', async () => {
    withdrawals.pay1 = { status: 'pending', userId: 'u1', amountUsd: 50 }
    await (pawapayPayoutWebhook as unknown as Handler)(fakeReq('pay1', 'FAILED'), fakeRes())
    expect(users.u1).toMatchObject({ walletUsd: 50 })
    expect(withdrawals.pay1).toMatchObject({ status: 'failed' })

    // PawaPay retries the same FAILED callback a second time.
    await (pawapayPayoutWebhook as unknown as Handler)(fakeReq('pay1', 'FAILED'), fakeRes())
    expect(users.u1).toMatchObject({ walletUsd: 50 }) // NOT 100
    expect(transactions).toHaveLength(1)
  })

  it('does not reprocess a retried COMPLETED payout webhook', async () => {
    withdrawals.pay2 = { status: 'pending', userId: 'u2', amountUsd: 30 }
    await (pawapayPayoutWebhook as unknown as Handler)(fakeReq('pay2', 'COMPLETED'), fakeRes())
    expect(transactions).toHaveLength(1)

    await (pawapayPayoutWebhook as unknown as Handler)(fakeReq('pay2', 'COMPLETED'), fakeRes())
    expect(transactions).toHaveLength(1)
  })

  it('processes a fresh pending payout normally', async () => {
    withdrawals.pay3 = { status: 'pending', userId: 'u3', amountUsd: 10 }
    const res = fakeRes()
    await (pawapayPayoutWebhook as unknown as Handler)(fakeReq('pay3', 'COMPLETED'), res)
    expect(res.statusCode).toBe(200)
    expect(withdrawals.pay3).toMatchObject({ status: 'completed' })
  })
})
