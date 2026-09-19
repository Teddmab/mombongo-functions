import { describe, it, expect, vi, beforeEach } from 'vitest'

function fixtureListing(overrides: Record<string, unknown> = {}) {
  return {
    commodity: 'Manioc', commodityCode: 'manioc', province: 'Kinshasa', territory: 'Lukaya', status: 'active',
    quantityKg: 100, quality: 'A', pricePerKgCdf: 500,
    sellerId: 'farmer1', sellerName: 'Jean Mbala', photoUrls: ['https://example.com/photo.jpg'],
    description: 'Bonne récolte', availableFrom: '2026-09-01T00:00:00.000Z', availableUntil: '2026-10-01T00:00:00.000Z',
    // Internal-only fields that must NOT leak into the partner response.
    sellerRole: 'farmer', createdAt: { seconds: 1 }, updatedAt: { seconds: 2 },
    ...overrides,
  }
}

let listingDocs: { id: string; data: () => Record<string, unknown> }[] = [{ id: 'l1', data: () => fixtureListing() }]
const whereFilters: [string, string, unknown][] = []
// testMode: true by default in these fixtures — most tests here exercise
// generic allowlist mechanics, not the production ceiling specifically
// (that gets its own describe block below). A testMode:false/unset
// partner is now always capped to PRODUCTION_ALLOWED_COMMODITY_CODES.
let partnerData: Record<string, unknown> = { testMode: true, allowedCommodityCodes: null }

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => {
      if (name === 'partners') {
        return { doc: () => ({ get: async () => ({ exists: true, data: () => partnerData }) }) }
      }
      if (name !== 'product_listings') throw new Error(`unexpected collection ${name}`)
      const chain: any = {
        where: (field: string, op: string, value: unknown) => {
          whereFilters.push([field, op, value])
          return chain
        },
        orderBy: () => chain,
        limit: () => chain,
        get: async () => ({ docs: listingDocs }),
      }
      return chain
    },
  },
  functions: {
    region: vi.fn(() => ({ https: { onRequest: vi.fn((h: unknown) => h) } })),
    logger: { warn: vi.fn() },
  },
}))

const { verifySigMock } = vi.hoisted(() => ({ verifySigMock: vi.fn() }))
vi.mock('../verifyPartnerSignature', () => ({ verifyPartnerSignature: verifySigMock }))

import { getExternalPublishedListings } from '../getExternalPublishedListings'

type Handler = (req: unknown, res: unknown) => Promise<void>

function fakeReq(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: 'POST',
    header: (name: string) => headers[name],
    body,
  }
}

function fakeRes() {
  const res = { statusCode: 0, body: undefined as unknown, status(c: number) { this.statusCode = c; return this }, send(b: unknown) { this.body = b }, json(b: unknown) { this.body = b } }
  return res
}

describe('getExternalPublishedListings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    whereFilters.length = 0
    partnerData = { testMode: true, allowedCommodityCodes: null }
    listingDocs = [{ id: 'l1', data: () => fixtureListing() }]
  })

  it('rejects a non-POST method', async () => {
    const res = fakeRes()
    await (getExternalPublishedListings as unknown as Handler)({ method: 'GET' }, res)
    expect(res.statusCode).toBe(405)
  })

  it('rejects an invalid signature', async () => {
    verifySigMock.mockResolvedValueOnce(false)
    const res = fakeRes()
    await (getExternalPublishedListings as unknown as Handler)(fakeReq({}), res)
    expect(res.statusCode).toBe(401)
  })

  it('returns listings, applying commodity/province filters when given, matched on the canonical commodityCode', async () => {
    verifySigMock.mockResolvedValueOnce(true)
    const res = fakeRes()
    await (getExternalPublishedListings as unknown as Handler)(
      fakeReq({ commodity: 'Manioc', province: 'Kinshasa' }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      listings: [{
        id: 'l1', commodity: 'Manioc', province: 'Kinshasa', territory: 'Lukaya',
        quantityKg: 100, quality: 'A', pricePerKgCdf: 500,
        sellerId: 'farmer1', sellerName: 'Jean Mbala', photoUrls: ['https://example.com/photo.jpg'],
        description: 'Bonne récolte', availableFrom: '2026-09-01T00:00:00.000Z', availableUntil: '2026-10-01T00:00:00.000Z',
        status: 'active',
      }],
    })
    expect(whereFilters).toEqual(
      expect.arrayContaining([
        ['status', '==', 'active'],
        ['commodityCode', '==', 'manioc'],
        ['province', '==', 'Kinshasa'],
      ]),
    )
  })

  it('canonicalizes a requested commodity before matching (case/accents/whitespace insensitive)', async () => {
    verifySigMock.mockResolvedValueOnce(true)
    const res = fakeRes()
    await (getExternalPublishedListings as unknown as Handler)(fakeReq({ commodity: '  MANIOC  ' }), res)
    expect(whereFilters).toContainEqual(['commodityCode', '==', 'manioc'])
  })

  it('never leaks internal-only fields (sellerRole, createdAt, updatedAt, commodityCode) into the response', async () => {
    verifySigMock.mockResolvedValueOnce(true)
    const res = fakeRes()
    await (getExternalPublishedListings as unknown as Handler)(fakeReq({}), res)
    const listing = (res.body as { listings: Record<string, unknown>[] }).listings[0]
    expect(listing).not.toHaveProperty('sellerRole')
    expect(listing).not.toHaveProperty('createdAt')
    expect(listing).not.toHaveProperty('updatedAt')
    expect(listing).not.toHaveProperty('commodityCode')
  })

  it('excludes a listing with no valid quantityKg (e.g. agent-published, incompatible schema) instead of showing a 0 kg listing', async () => {
    listingDocs = [
      { id: 'l1', data: () => fixtureListing() },
      { id: 'l2-agent-published', data: () => ({ commodity: 'Maïs', commodityCode: 'mais', province: 'Kongo Central', status: 'active', quantityDesc: '2 sacs', pricePerUnitCdf: 20000 }) },
    ]
    verifySigMock.mockResolvedValueOnce(true)
    const res = fakeRes()
    await (getExternalPublishedListings as unknown as Handler)(fakeReq({}), res)
    const ids = (res.body as { listings: { id: string }[] }).listings.map((l) => l.id)
    expect(ids).toEqual(['l1'])
  })

  it('normalizes a Firestore Timestamp-shaped availableFrom/availableUntil to an ISO string', async () => {
    const toDate = () => new Date('2026-09-01T00:00:00.000Z')
    listingDocs = [{ id: 'l1', data: () => fixtureListing({ availableFrom: { toDate }, availableUntil: null }) }]
    verifySigMock.mockResolvedValueOnce(true)
    const res = fakeRes()
    await (getExternalPublishedListings as unknown as Handler)(fakeReq({}), res)
    const listing = (res.body as { listings: Record<string, unknown>[] }).listings[0]
    expect(listing.availableFrom).toBe('2026-09-01T00:00:00.000Z')
    expect(listing.availableUntil).toBeNull()
  })

  describe('per-partner catalog scoping (allowedCommodityCodes) — testMode partners', () => {
    it('is unrestricted when allowedCommodityCodes is null (pre-existing partners, unchanged behavior)', async () => {
      partnerData = { testMode: true, allowedCommodityCodes: null }
      verifySigMock.mockResolvedValueOnce(true)
      const res = fakeRes()
      await (getExternalPublishedListings as unknown as Handler)(fakeReq({}), res)
      expect(res.statusCode).toBe(200)
      expect((res.body as { listings: unknown[] }).listings).toHaveLength(1)
      expect(whereFilters.some(([field]) => field === 'commodityCode')).toBe(false)
    })

    it('scopes the query to the allowlist when no commodity is requested', async () => {
      partnerData = { testMode: true, allowedCommodityCodes: ['ananas'] }
      verifySigMock.mockResolvedValueOnce(true)
      const res = fakeRes()
      await (getExternalPublishedListings as unknown as Handler)(fakeReq({}), res)
      expect(whereFilters).toContainEqual(['commodityCode', 'in', ['ananas']])
    })

    it('returns nothing, without querying, when the requested commodity is outside the allowlist', async () => {
      partnerData = { testMode: true, allowedCommodityCodes: ['ananas'] }
      verifySigMock.mockResolvedValueOnce(true)
      const res = fakeRes()
      await (getExternalPublishedListings as unknown as Handler)(fakeReq({ commodity: 'Manioc' }), res)
      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual({ listings: [] })
      expect(whereFilters).toHaveLength(0)
    })

    it('allows the requested commodity through when it is in the allowlist', async () => {
      partnerData = { testMode: true, allowedCommodityCodes: ['ananas', 'manioc'] }
      verifySigMock.mockResolvedValueOnce(true)
      const res = fakeRes()
      await (getExternalPublishedListings as unknown as Handler)(fakeReq({ commodity: 'Manioc' }), res)
      expect(res.statusCode).toBe(200)
      expect(whereFilters).toContainEqual(['commodityCode', '==', 'manioc'])
    })

    it('returns nothing when allowedCommodityCodes is explicitly empty — that means nothing, not everything', async () => {
      partnerData = { testMode: true, allowedCommodityCodes: [] }
      verifySigMock.mockResolvedValueOnce(true)
      const res = fakeRes()
      await (getExternalPublishedListings as unknown as Handler)(fakeReq({}), res)
      expect(res.body).toEqual({ listings: [] })
      expect(whereFilters).toHaveLength(0)
    })
  })

  describe('production ceiling (testMode: false) — PRODUCTION_ALLOWED_COMMODITY_CODES = ["ananas"]', () => {
    it('caps an unconfigured production partner to the ceiling, never "everything"', async () => {
      partnerData = { testMode: false, allowedCommodityCodes: null }
      verifySigMock.mockResolvedValueOnce(true)
      const res = fakeRes()
      await (getExternalPublishedListings as unknown as Handler)(fakeReq({}), res)
      expect(whereFilters).toContainEqual(['commodityCode', 'in', ['ananas']])
    })

    it('same result when testMode is simply absent from the doc (fail-closed default)', async () => {
      partnerData = { allowedCommodityCodes: null }
      verifySigMock.mockResolvedValueOnce(true)
      const res = fakeRes()
      await (getExternalPublishedListings as unknown as Handler)(fakeReq({}), res)
      expect(whereFilters).toContainEqual(['commodityCode', 'in', ['ananas']])
    })

    it('intersects a broader configured allowlist down to the ceiling — cannot widen production', async () => {
      partnerData = { testMode: false, allowedCommodityCodes: ['ananas', 'manioc', 'cacao'] }
      verifySigMock.mockResolvedValueOnce(true)
      const res = fakeRes()
      await (getExternalPublishedListings as unknown as Handler)(fakeReq({}), res)
      expect(whereFilters).toContainEqual(['commodityCode', 'in', ['ananas']])
    })

    it('rejects a production request for a commodity outside the ceiling even if configured on the partner', async () => {
      partnerData = { testMode: false, allowedCommodityCodes: ['ananas', 'manioc'] }
      verifySigMock.mockResolvedValueOnce(true)
      const res = fakeRes()
      await (getExternalPublishedListings as unknown as Handler)(fakeReq({ commodity: 'Manioc' }), res)
      expect(res.body).toEqual({ listings: [] })
    })

    it('QA (testMode: true) is NOT capped by the production ceiling and may use additional test commodities', async () => {
      partnerData = { testMode: true, allowedCommodityCodes: ['ananas', 'manioc', 'papaye-test'] }
      verifySigMock.mockResolvedValueOnce(true)
      const res = fakeRes()
      await (getExternalPublishedListings as unknown as Handler)(fakeReq({}), res)
      expect(whereFilters).toContainEqual(['commodityCode', 'in', ['ananas', 'manioc', 'papaye-test']])
    })
  })
})
