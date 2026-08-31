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

import { adminUpdatePartnerWebhookUrl } from '../adminUpdatePartnerWebhookUrl'

type Handler = (data: unknown, context: { auth?: { uid: string } }) => Promise<unknown>

describe('adminUpdatePartnerWebhookUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const k of Object.keys(users)) delete users[k]
    for (const k of Object.keys(partners)) delete partners[k]
  })

  it('rejects an unauthenticated caller', async () => {
    await expect(
      (adminUpdatePartnerWebhookUrl as unknown as Handler)({ partnerId: 'arom', webhookUrl: 'https://x.com/hook' }, {}),
    ).rejects.toThrow('Login required')
  })

  it('rejects a non-admin caller', async () => {
    users['u1'] = { role: 'merchant' }
    await expect(
      (adminUpdatePartnerWebhookUrl as unknown as Handler)(
        { partnerId: 'arom', webhookUrl: 'https://x.com/hook' },
        { auth: { uid: 'u1' } },
      ),
    ).rejects.toThrow('Admin only')
  })

  it('rejects a non-https URL', async () => {
    users['admin1'] = { role: 'admin' }
    await expect(
      (adminUpdatePartnerWebhookUrl as unknown as Handler)(
        { partnerId: 'arom', webhookUrl: 'http://x.com/hook' },
        { auth: { uid: 'admin1' } },
      ),
    ).rejects.toThrow('https')
  })

  it('rejects a private IP target', async () => {
    users['admin1'] = { role: 'admin' }
    await expect(
      (adminUpdatePartnerWebhookUrl as unknown as Handler)(
        { partnerId: 'arom', webhookUrl: 'https://10.0.0.5/hook' },
        { auth: { uid: 'admin1' } },
      ),
    ).rejects.toThrow('privée')
  })

  it('rejects an unknown partnerId', async () => {
    users['admin1'] = { role: 'admin' }
    await expect(
      (adminUpdatePartnerWebhookUrl as unknown as Handler)(
        { partnerId: 'nope', webhookUrl: 'https://x.com/hook' },
        { auth: { uid: 'admin1' } },
      ),
    ).rejects.toThrow('not found')
  })

  it('updates webhookUrl for a valid request', async () => {
    users['admin1'] = { role: 'admin' }
    partners['arom'] = { name: 'AROM' }
    const result = await (adminUpdatePartnerWebhookUrl as unknown as Handler)(
      { partnerId: 'arom', webhookUrl: 'https://webhooks.arom.cd/mombongo' },
      { auth: { uid: 'admin1' } },
    )
    expect(result).toEqual({ success: true })
    expect(updateMock).toHaveBeenCalledWith({ webhookUrl: 'https://webhooks.arom.cd/mombongo' })
  })
})
