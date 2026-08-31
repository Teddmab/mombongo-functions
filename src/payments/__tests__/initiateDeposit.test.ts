import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/admin', () => ({
  admin: { firestore: { FieldValue: { serverTimestamp: vi.fn(), increment: vi.fn() } } },
  db: { collection: vi.fn() },
  functions: {
    runWith: vi.fn(() => ({
      region: vi.fn(() => ({
        https: { onCall: vi.fn((h: unknown) => h) },
      })),
    })),
    https: {
      HttpsError: class extends Error {
        constructor(public code: string, msg: string) { super(msg) }
      },
    },
  },
}))

import { getUsdToCdf } from '../initiateDeposit'

// Minimal Firestore stub that returns a doc snapshot
function makeDb(data: Record<string, unknown> | null): FirebaseFirestore.Firestore {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => ({
          exists: data !== null,
          data: () => data ?? undefined,
        }),
      }),
    }),
  } as unknown as FirebaseFirestore.Firestore
}

describe('getUsdToCdf — F-002 exchange rate from Firestore', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('returns the rate from Firestore when the document exists', async () => {
    expect(await getUsdToCdf(makeDb({ usdToCdf: 2900 }))).toBe(2900)
  })

  it('uses the exact Firestore rate, not the fallback (2800)', async () => {
    // Ensures the live rate is actually being read
    expect(await getUsdToCdf(makeDb({ usdToCdf: 3100 }))).toBe(3100)
  })

  it('returns 2800 fallback and warns when the document is missing', async () => {
    const rate = await getUsdToCdf(makeDb(null))
    expect(rate).toBe(2800)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('not found'))
  })

  it('returns 2800 fallback and warns when usdToCdf is 0', async () => {
    const rate = await getUsdToCdf(makeDb({ usdToCdf: 0 }))
    expect(rate).toBe(2800)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('invalid'))
  })

  it('returns 2800 fallback and warns when usdToCdf is negative', async () => {
    const rate = await getUsdToCdf(makeDb({ usdToCdf: -500 }))
    expect(rate).toBe(2800)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('invalid'))
  })

  it('returns 2800 fallback and warns when usdToCdf is a string', async () => {
    const rate = await getUsdToCdf(makeDb({ usdToCdf: '2800' }))
    expect(rate).toBe(2800)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('invalid'))
  })

  it('returns 2800 fallback and warns when Firestore throws', async () => {
    const errorDb = {
      collection: () => ({
        doc: () => ({
          get: async () => { throw new Error('Firestore unavailable') },
        }),
      }),
    } as unknown as FirebaseFirestore.Firestore
    const rate = await getUsdToCdf(errorDb)
    expect(rate).toBe(2800)
    expect(console.warn).toHaveBeenCalled()
  })
})
