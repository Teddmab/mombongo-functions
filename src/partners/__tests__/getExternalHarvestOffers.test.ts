import { describe, it, expect, vi, beforeEach } from 'vitest'

interface FakeOffer {
  id: string
  partnerId: string
  status: string
  updatedAt: string // ISO, used both as sort key and as the Timestamp stand-in
  [k: string]: unknown
}

let allOffers: FakeOffer[] = []
let capturedFilters: [string, string, unknown][] = []
let capturedStartAfter: unknown[] | null = null
let capturedLimit: number | null = null

function isoOf(v: unknown): string {
  if (v && typeof v === 'object' && 'toDate' in (v as object)) return (v as { toDate: () => Date }).toDate().toISOString()
  return String(v)
}

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => {
      if (name !== 'harvest_offers') throw new Error(`unexpected collection ${name}`)
      const chain: any = {
        where: (field: string, op: string, value: unknown) => {
          capturedFilters.push([field, op, isoOf(value)])
          return chain
        },
        orderBy: () => chain,
        startAfter: (...args: unknown[]) => {
          capturedStartAfter = args.map(isoOf)
          return chain
        },
        limit: (n: number) => {
          capturedLimit = n
          return chain
        },
        get: async () => {
          let rows = [...allOffers]
          for (const [field, op, value] of capturedFilters) {
            if (op === '==') rows = rows.filter((r) => String((r as any)[field]) === value)
            if (op === '>') rows = rows.filter((r) => (r as any)[field] > (value as string))
          }
          rows.sort((a, b) => (a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : a.updatedAt.localeCompare(b.updatedAt)))
          if (capturedStartAfter) {
            const [afterUpdatedAt, afterId] = capturedStartAfter as [string, string]
            rows = rows.filter((r) => r.updatedAt > afterUpdatedAt || (r.updatedAt === afterUpdatedAt && r.id > afterId))
          }
          const limited = capturedLimit ? rows.slice(0, capturedLimit) : rows
          return { docs: limited.map((r) => ({ id: r.id, data: () => r })) }
        },
      }
      return chain
    },
  },
  functions: { region: vi.fn(() => ({ https: { onRequest: vi.fn((h: unknown) => h) } })) },
}))

vi.mock('firebase-admin/firestore', () => ({
  Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) },
}))

const { verifySigMock } = vi.hoisted(() => ({ verifySigMock: vi.fn() }))
vi.mock('../verifyPartnerSignature', () => ({ verifyPartnerSignature: verifySigMock }))

import { getExternalHarvestOffers } from '../getExternalHarvestOffers'

type Handler = (req: unknown, res: unknown) => Promise<void>

function fakeReq(body: unknown, headers: Record<string, string> = { 'x-partner-id': 'arom' }) {
  return { method: 'POST', header: (name: string) => headers[name], body }
}
function fakeRes() {
  return { statusCode: 0, body: undefined as unknown, status(c: number) { this.statusCode = c; return this }, send(b: unknown) { this.body = b }, json(b: unknown) { this.body = b } }
}

function offer(id: string, partnerId: string, status: string, updatedAt: string, extra: Record<string, unknown> = {}): FakeOffer {
  return { id, partnerId, status, updatedAt, listingId: 'l1', offerQuantityKg: 10, offerPricePerKgCdf: 100, ...extra }
}

describe('getExternalHarvestOffers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedFilters = []
    capturedStartAfter = null
    capturedLimit = null
    allOffers = []
  })

  it('rejects an invalid signature', async () => {
    verifySigMock.mockResolvedValueOnce(false)
    const res = fakeRes()
    await (getExternalHarvestOffers as unknown as Handler)(fakeReq({}), res)
    expect(res.statusCode).toBe(401)
  })

  it('rejects an invalid status filter', async () => {
    verifySigMock.mockResolvedValueOnce(true)
    const res = fakeRes()
    await (getExternalHarvestOffers as unknown as Handler)(fakeReq({ status: 'refused' }), res)
    expect(res.statusCode).toBe(400)
  })

  it('rejects a malformed updatedSince', async () => {
    verifySigMock.mockResolvedValueOnce(true)
    const res = fakeRes()
    await (getExternalHarvestOffers as unknown as Handler)(fakeReq({ updatedSince: 'not-a-date' }), res)
    expect(res.statusCode).toBe(400)
  })

  it('rejects a malformed cursor', async () => {
    verifySigMock.mockResolvedValueOnce(true)
    const res = fakeRes()
    await (getExternalHarvestOffers as unknown as Handler)(fakeReq({ cursor: 'not-base64-json' }), res)
    expect(res.statusCode).toBe(400)
  })

  it('never reads another partner\'s offers, even if none are requested for the caller — server always filters by the verified partnerId', async () => {
    allOffers = [offer('o1', 'someone-else', 'pending', '2026-09-01T00:00:00.000Z')]
    verifySigMock.mockResolvedValueOnce(true)
    const res = fakeRes()
    await (getExternalHarvestOffers as unknown as Handler)(fakeReq({}, { 'x-partner-id': 'arom' }), res)
    expect(res.statusCode).toBe(200)
    expect((res.body as { offers: unknown[] }).offers).toHaveLength(0)
    expect(capturedFilters).toContainEqual(['partnerId', '==', 'arom'])
  })

  it('lists only the calling partner\'s offers, ignoring another partner\'s offers on the same listing', async () => {
    allOffers = [
      offer('o1', 'arom', 'pending', '2026-09-01T00:00:00.000Z'),
      offer('o2', 'someone-else', 'pending', '2026-09-01T00:00:01.000Z'),
    ]
    verifySigMock.mockResolvedValueOnce(true)
    const res = fakeRes()
    await (getExternalHarvestOffers as unknown as Handler)(fakeReq({}), res)
    const ids = (res.body as { offers: { offerId: string }[] }).offers.map((o) => o.offerId)
    expect(ids).toEqual(['o1'])
  })

  it('applies the status filter', async () => {
    allOffers = [
      offer('o1', 'arom', 'pending', '2026-09-01T00:00:00.000Z'),
      offer('o2', 'arom', 'accepted', '2026-09-01T00:00:01.000Z'),
    ]
    verifySigMock.mockResolvedValueOnce(true)
    const res = fakeRes()
    await (getExternalHarvestOffers as unknown as Handler)(fakeReq({ status: 'accepted' }), res)
    const ids = (res.body as { offers: { offerId: string }[] }).offers.map((o) => o.offerId)
    expect(ids).toEqual(['o2'])
  })

  it('applies the updatedSince filter', async () => {
    allOffers = [
      offer('o1', 'arom', 'pending', '2026-09-01T00:00:00.000Z'),
      offer('o2', 'arom', 'pending', '2026-09-03T00:00:00.000Z'),
    ]
    verifySigMock.mockResolvedValueOnce(true)
    const res = fakeRes()
    await (getExternalHarvestOffers as unknown as Handler)(fakeReq({ updatedSince: '2026-09-02T00:00:00.000Z' }), res)
    const ids = (res.body as { offers: { offerId: string }[] }).offers.map((o) => o.offerId)
    expect(ids).toEqual(['o2'])
  })

  it('paginates with a stable cursor across two pages, in ascending updatedAt order, covering every offer exactly once', async () => {
    allOffers = [
      offer('o1', 'arom', 'pending', '2026-09-01T00:00:00.000Z'),
      offer('o2', 'arom', 'pending', '2026-09-02T00:00:00.000Z'),
      offer('o3', 'arom', 'pending', '2026-09-03T00:00:00.000Z'),
    ]
    verifySigMock.mockResolvedValueOnce(true)
    const res1 = fakeRes()
    await (getExternalHarvestOffers as unknown as Handler)(fakeReq({ limit: 2 }), res1)
    const page1 = res1.body as { offers: { offerId: string }[]; nextCursor: string | null }
    expect(page1.offers.map((o) => o.offerId)).toEqual(['o1', 'o2'])
    expect(page1.nextCursor).toBeTruthy()

    verifySigMock.mockResolvedValueOnce(true)
    const res2 = fakeRes()
    await (getExternalHarvestOffers as unknown as Handler)(fakeReq({ limit: 2, cursor: page1.nextCursor }), res2)
    const page2 = res2.body as { offers: { offerId: string }[]; nextCursor: string | null }
    expect(page2.offers.map((o) => o.offerId)).toEqual(['o3'])
    expect(page2.nextCursor).toBeNull() // last page — fewer results than the limit
  })

  it('caps limit at MAX_LIMIT (100) even if a larger value is requested', async () => {
    verifySigMock.mockResolvedValueOnce(true)
    const res = fakeRes()
    await (getExternalHarvestOffers as unknown as Handler)(fakeReq({ limit: 99999 }), res)
    expect(capturedLimit).toBe(100)
  })
})
