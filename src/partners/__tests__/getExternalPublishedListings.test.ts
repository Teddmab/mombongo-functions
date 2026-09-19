import { describe, it, expect, vi, beforeEach } from 'vitest'

let listingDocs: { id: string; data: () => Record<string, unknown> }[] = [
  {
    id: 'l1',
    data: () => ({
      commodity: 'Manioc', province: 'Kinshasa', territory: 'Lukaya', status: 'active',
      quantityKg: 100, quality: 'A', pricePerKgCdf: 500,
      sellerId: 'farmer1', sellerName: 'Jean Mbala', photoUrls: ['https://example.com/photo.jpg'],
      description: 'Bonne récolte', availableFrom: '2026-09-01T00:00:00.000Z', availableUntil: '2026-10-01T00:00:00.000Z',
      // Internal-only fields that must NOT leak into the partner response.
      sellerRole: 'farmer', createdAt: { seconds: 1 }, updatedAt: { seconds: 2 },
    }),
  },
]
const whereFilters: [string, string, unknown][] = []
let partnerData: Record<string, unknown> = { allowedCommodities: null }

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
    partnerData = { allowedCommodities: null }
    listingDocs = [
      {
        id: 'l1',
        data: () => ({
          commodity: 'Manioc', province: 'Kinshasa', territory: 'Lukaya', status: 'active',
          quantityKg: 100, quality: 'A', pricePerKgCdf: 500,
          sellerId: 'farmer1', sellerName: 'Jean Mbala', photoUrls: ['https://example.com/photo.jpg'],
          description: 'Bonne récolte', availableFrom: '2026-09-01T00:00:00.000Z', availableUntil: '2026-10-01T00:00:00.000Z',
          sellerRole: 'farmer', createdAt: { seconds: 1 }, updatedAt: { seconds: 2 },
        }),
      },
    ]
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

  it('returns listings, applying commodity/province filters when given', async () => {
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
        ['commodity', '==', 'Manioc'],
        ['province', '==', 'Kinshasa'],
      ]),
    )
  })

  it('never leaks internal-only fields (sellerRole, createdAt, updatedAt) into the response', async () => {
    verifySigMock.mockResolvedValueOnce(true)
    const res = fakeRes()
    await (getExternalPublishedListings as unknown as Handler)(fakeReq({}), res)
    const listing = (res.body as { listings: Record<string, unknown>[] }).listings[0]
    expect(listing).not.toHaveProperty('sellerRole')
    expect(listing).not.toHaveProperty('createdAt')
    expect(listing).not.toHaveProperty('updatedAt')
  })

  it('excludes a listing with no valid quantityKg (e.g. agent-published, incompatible schema) instead of showing a 0 kg listing', async () => {
    listingDocs = [
      { id: 'l1', data: () => ({ commodity: 'Manioc', province: 'Kinshasa', status: 'active', quantityKg: 100, pricePerKgCdf: 500 }) },
      { id: 'l2-agent-published', data: () => ({ commodity: 'Maïs', province: 'Kongo Central', status: 'active', quantityDesc: '2 sacs', pricePerUnitCdf: 20000 }) },
    ]
    verifySigMock.mockResolvedValueOnce(true)
    const res = fakeRes()
    await (getExternalPublishedListings as unknown as Handler)(fakeReq({}), res)
    const ids = (res.body as { listings: { id: string }[] }).listings.map((l) => l.id)
    expect(ids).toEqual(['l1'])
  })

  it('normalizes a Firestore Timestamp-shaped availableFrom/availableUntil to an ISO string', async () => {
    const toDate = () => new Date('2026-09-01T00:00:00.000Z')
    listingDocs = [
      { id: 'l1', data: () => ({ commodity: 'Manioc', province: 'Kinshasa', status: 'active', quantityKg: 100, pricePerKgCdf: 500, availableFrom: { toDate }, availableUntil: null }) },
    ]
    verifySigMock.mockResolvedValueOnce(true)
    const res = fakeRes()
    await (getExternalPublishedListings as unknown as Handler)(fakeReq({}), res)
    const listing = (res.body as { listings: Record<string, unknown>[] }).listings[0]
    expect(listing.availableFrom).toBe('2026-09-01T00:00:00.000Z')
    expect(listing.availableUntil).toBeNull()
  })

  describe('per-partner catalog scoping (allowedCommodities)', () => {
    it('is unrestricted when allowedCommodities is null (pre-existing partners, unchanged behavior)', async () => {
      partnerData = { allowedCommodities: null }
      verifySigMock.mockResolvedValueOnce(true)
      const res = fakeRes()
      await (getExternalPublishedListings as unknown as Handler)(fakeReq({}), res)
      expect(res.statusCode).toBe(200)
      expect((res.body as { listings: unknown[] }).listings).toHaveLength(1)
      expect(whereFilters.some(([field]) => field === 'commodity')).toBe(false)
    })

    it('scopes the query to the allowlist when no commodity is requested', async () => {
      partnerData = { allowedCommodities: ['Ananas'] }
      verifySigMock.mockResolvedValueOnce(true)
      const res = fakeRes()
      await (getExternalPublishedListings as unknown as Handler)(fakeReq({}), res)
      expect(whereFilters).toContainEqual(['commodity', 'in', ['Ananas']])
    })

    it('returns nothing, without querying, when the requested commodity is outside the allowlist', async () => {
      partnerData = { allowedCommodities: ['Ananas'] }
      verifySigMock.mockResolvedValueOnce(true)
      const res = fakeRes()
      await (getExternalPublishedListings as unknown as Handler)(fakeReq({ commodity: 'Manioc' }), res)
      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual({ listings: [] })
      expect(whereFilters).toHaveLength(0)
    })

    it('allows the requested commodity through when it is in the allowlist', async () => {
      partnerData = { allowedCommodities: ['Ananas', 'Manioc'] }
      verifySigMock.mockResolvedValueOnce(true)
      const res = fakeRes()
      await (getExternalPublishedListings as unknown as Handler)(fakeReq({ commodity: 'Manioc' }), res)
      expect(res.statusCode).toBe(200)
      expect(whereFilters).toContainEqual(['commodity', '==', 'Manioc'])
    })

    it('returns nothing when allowedCommodities is explicitly empty — that means nothing, not everything', async () => {
      partnerData = { allowedCommodities: [] }
      verifySigMock.mockResolvedValueOnce(true)
      const res = fakeRes()
      await (getExternalPublishedListings as unknown as Handler)(fakeReq({}), res)
      expect(res.body).toEqual({ listings: [] })
      expect(whereFilters).toHaveLength(0)
    })
  })
})
