import { describe, it, expect, beforeEach, vi } from 'vitest'

const users: Record<string, { role?: string } | undefined> = {}

function makeQuery(count = 0, docs: Record<string, unknown>[] = []) {
  const q = {
    where: () => q,
    count: () => ({ get: async () => ({ data: () => ({ count }) }) }),
    get: async () => ({ docs: docs.map((d, i) => ({ id: String(i), data: () => d })) }),
  }
  return q
}

vi.mock('../../lib/admin', () => {
  const fakeDb = {
    collection: (_name: string) => ({
      where: () => makeQuery(0, []),
      doc: (id: string) => ({ get: async () => ({ exists: users[id] !== undefined, data: () => users[id] }) }),
    }),
  }
  return {
    admin: {
      firestore: Object.assign(() => fakeDb, { Timestamp: { fromDate: () => 'TS' } }),
    },
    functions: {
      region: vi.fn(() => ({ https: { onCall: vi.fn((h: unknown) => h) } })),
      https: { HttpsError: class extends Error { constructor(public code: string, msg: string) { super(msg) } } },
    },
  }
})

import { getDashboardKpis } from '../getDashboardKpis'

type Handler = (data: unknown, context: { auth?: { uid: string } }) => Promise<unknown>
const call = getDashboardKpis as unknown as Handler

describe('getDashboardKpis', () => {
  beforeEach(() => {
    for (const k of Object.keys(users)) delete users[k]
  })

  it('rejects an unauthenticated caller', async () => {
    await expect(call({}, {})).rejects.toThrow('Login required')
  })

  it('rejects an authenticated caller who is not an admin — platform-wide financial KPIs are admin-only', async () => {
    users['farmer1'] = { role: 'farmer' }
    await expect(call({}, { auth: { uid: 'farmer1' } })).rejects.toThrow('Admin only')
  })

  it('rejects a caller with no role set at all', async () => {
    users['nobody'] = {}
    await expect(call({}, { auth: { uid: 'nobody' } })).rejects.toThrow('Admin only')
  })

  it('allows an admin caller through', async () => {
    users['admin1'] = { role: 'admin' }
    const result = await call({}, { auth: { uid: 'admin1' } }) as Record<string, unknown>
    expect(result).toHaveProperty('activeUsers')
    expect(result).toHaveProperty('monthlyVolumeUsd')
  })
})
