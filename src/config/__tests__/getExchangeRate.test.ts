import { describe, it, expect, vi } from 'vitest'

vi.mock('../../lib/admin', () => ({
  admin: { firestore: vi.fn() },
  db: { collection: vi.fn() },
  functions: {
    region: vi.fn(() => ({ https: { onCall: vi.fn((h: unknown) => h) } })),
    https: { HttpsError: class extends Error {} },
  },
}))
vi.mock('../../payments/initiateDeposit', () => ({
  getUsdToCdf: vi.fn(async () => 2950),
}))

import { getExchangeRate } from '../getExchangeRate'

describe('getExchangeRate — reads the same source as payment functions', () => {
  it('returns the rate from getUsdToCdf, not a hardcoded default', async () => {
    const result = await (getExchangeRate as unknown as (data: unknown, ctx: unknown) => Promise<{ rate: number; updatedAt: string }>)(
      {},
      {},
    )
    expect(result.rate).toBe(2950)
    expect(typeof result.updatedAt).toBe('string')
  })
})
