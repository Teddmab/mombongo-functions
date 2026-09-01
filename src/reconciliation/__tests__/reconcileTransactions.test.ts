import { describe, it, expect, vi, beforeEach } from 'vitest'

const users: Record<string, { role?: string } | undefined> = {}

const { coreMock } = vi.hoisted(() => ({ coreMock: vi.fn(async () => ({ checked: 3, exceptions: 1 })) }))
vi.mock('../reconcileTransactionsCore', () => ({ reconcileRecentTransactions: coreMock }))

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => {
      if (name === 'users') return { doc: (id: string) => ({ get: async () => ({ data: () => users[id] }) }) }
      throw new Error(`unexpected collection ${name}`)
    },
  },
  functions: {
    region: vi.fn(() => ({
      https: { onCall: vi.fn((h: unknown) => h) },
      pubsub: { schedule: vi.fn(() => ({ timeZone: vi.fn(() => ({ onRun: vi.fn((h: unknown) => h) })) })) },
    })),
    https: { HttpsError: class extends Error { constructor(public code: string, msg: string) { super(msg) } } },
    logger: { info: vi.fn() },
  },
}))

import { reconcileTransactions, runReconciliationCheck } from '../reconcileTransactions'

type CallableHandler = (data: unknown, context: { auth?: { uid: string } }) => Promise<unknown>

describe('reconcileTransactions (scheduled)', () => {
  beforeEach(() => { coreMock.mockClear() })

  it('runs the core check on schedule with no auth required', async () => {
    await (reconcileTransactions as unknown as () => Promise<void>)()
    expect(coreMock).toHaveBeenCalledWith(7, 200)
  })
})

describe('runReconciliationCheck (admin-triggered)', () => {
  beforeEach(() => {
    coreMock.mockClear()
    for (const k of Object.keys(users)) delete users[k]
    users['admin1'] = { role: 'admin' }
  })

  it('rejects a non-admin caller', async () => {
    users['u1'] = { role: 'merchant' }
    await expect((runReconciliationCheck as unknown as CallableHandler)({}, { auth: { uid: 'u1' } })).rejects.toThrow('Admin only')
  })

  it('runs the same core check on demand', async () => {
    const result = await (runReconciliationCheck as unknown as CallableHandler)({}, { auth: { uid: 'admin1' } })
    expect(result).toEqual({ checked: 3, exceptions: 1 })
    expect(coreMock).toHaveBeenCalledWith(7, 200)
  })
})
