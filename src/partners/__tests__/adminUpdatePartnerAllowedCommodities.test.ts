import { describe, it, expect, vi, beforeEach } from 'vitest'

const users: Record<string, { role?: string } | undefined> = {}
const partners: Record<string, Record<string, unknown> | undefined> = {}
const updateMock = vi.fn()

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => {
      if (name === 'users') {
        return { doc: (id: string) => ({ get: async () => ({ data: () => users[id] }) }) }
      }
      if (name === 'partners') {
        return {
          doc: (id: string) => ({
            get: async () => ({ exists: partners[id] !== undefined, data: () => partners[id] }),
            update: updateMock,
          }),
        }
      }
      throw new Error(`unexpected collection ${name}`)
    },
  },
  functions: {
    region: vi.fn(() => ({ https: { onCall: vi.fn((h: unknown) => h) } })),
    https: {
      HttpsError: class extends Error {
        constructor(public code: string, msg: string) { super(msg) }
      },
    },
    logger: { info: vi.fn() },
  },
}))

import { adminUpdatePartnerAllowedCommodities } from '../adminUpdatePartnerAllowedCommodities'

type Handler = (data: unknown, context: { auth?: { uid: string } }) => Promise<unknown>
const call = adminUpdatePartnerAllowedCommodities as unknown as Handler

describe('adminUpdatePartnerAllowedCommodities', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const k of Object.keys(users)) delete users[k]
    for (const k of Object.keys(partners)) delete partners[k]
  })

  it('rejects an unauthenticated caller', async () => {
    await expect(call({ partnerId: 'arom', allowedCommodities: ['Ananas'] }, {})).rejects.toThrow('Login required')
  })

  it('rejects a non-admin caller', async () => {
    users['u1'] = { role: 'merchant' }
    await expect(
      call({ partnerId: 'arom', allowedCommodities: ['Ananas'] }, { auth: { uid: 'u1' } }),
    ).rejects.toThrow('Admin only')
  })

  it('rejects a non-array, non-null allowedCommodities', async () => {
    users['admin1'] = { role: 'admin' }
    await expect(
      call({ partnerId: 'arom', allowedCommodities: 'Ananas' }, { auth: { uid: 'admin1' } }),
    ).rejects.toThrow('array')
  })

  it('rejects an array containing an empty string', async () => {
    users['admin1'] = { role: 'admin' }
    await expect(
      call({ partnerId: 'arom', allowedCommodities: ['Ananas', '  '] }, { auth: { uid: 'admin1' } }),
    ).rejects.toThrow('array')
  })

  it('rejects an unknown partnerId', async () => {
    users['admin1'] = { role: 'admin' }
    await expect(
      call({ partnerId: 'nope', allowedCommodities: ['Ananas'] }, { auth: { uid: 'admin1' } }),
    ).rejects.toThrow('not found')
  })

  it('sets an allowlist for a valid request', async () => {
    users['admin1'] = { role: 'admin' }
    partners['arom-qa-6d6e2e2a'] = { name: 'AROM QA' }
    const result = await call(
      { partnerId: 'arom-qa-6d6e2e2a', allowedCommodities: ['Ananas'] },
      { auth: { uid: 'admin1' } },
    )
    expect(result).toEqual({ success: true })
    expect(updateMock).toHaveBeenCalledWith({ allowedCommodities: ['Ananas'] })
  })

  it('clears the restriction when allowedCommodities is null', async () => {
    users['admin1'] = { role: 'admin' }
    partners['arom'] = { name: 'AROM' }
    await call({ partnerId: 'arom', allowedCommodities: null }, { auth: { uid: 'admin1' } })
    expect(updateMock).toHaveBeenCalledWith({ allowedCommodities: null })
  })
})
