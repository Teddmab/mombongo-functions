import { describe, it, expect, vi, beforeEach } from 'vitest'

const BUCKET = 'test-bucket'

interface StoredOffer { id: string; [k: string]: unknown }
let offers: StoredOffer[] = []
const listings: Record<string, Record<string, unknown> | undefined> = {}
const getAllMock = vi.fn()
const getSignedUrlMock = vi.fn()
const fileMock = vi.fn()
let filters: [string, string, unknown][] = []
let limitN: number | null = null

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => {
      if (name === 'product_listings') return { doc: (id: string) => ({ id }) }
      if (name !== 'harvest_offers') throw new Error(`unexpected collection ${name}`)
      const chain: any = {
        doc: (id: string) => ({
          get: async () => {
            const o = offers.find((x) => x.id === id)
            return { exists: !!o, id, data: () => o }
          },
        }),
        where: (f: string, op: string, v: unknown) => { filters.push([f, op, v]); return chain },
        orderBy: () => chain,
        startAfter: () => chain,
        limit: (n: number) => { limitN = n; return chain },
        get: async () => {
          let rows = offers.filter((o) => filters.every(([f, , v]) => f === 'updatedAt' || o[f] === v))
          rows = [...rows].sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
          if (limitN) rows = rows.slice(0, limitN)
          return { empty: rows.length === 0, docs: rows.map((r) => ({ id: r.id, data: () => r })) }
        },
      }
      return chain
    },
    getAll: (...refs: { id: string }[]) => getAllMock(...refs),
  },
  functions: { region: vi.fn(() => ({ https: { onRequest: vi.fn((h: unknown) => h) } })) },
}))
vi.mock('firebase-admin/firestore', () => ({ Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) } }))
vi.mock('firebase-admin/storage', () => ({
  getStorage: () => ({ bucket: () => ({ name: BUCKET, file: fileMock }) }),
}))
vi.mock('firebase-functions/logger', () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }))

const { verifySigMock } = vi.hoisted(() => ({ verifySigMock: vi.fn() }))
vi.mock('../verifyPartnerSignature', () => ({ verifyPartnerSignature: verifySigMock }))

import { getExternalHarvestOffer } from '../getExternalHarvestOffer'
import { getExternalHarvestOffers } from '../getExternalHarvestOffers'
import { toExternalHarvestOfferDto } from '../externalHarvestOfferDto'

type Handler = (req: unknown, res: unknown) => Promise<void>

function fakeReq(body: unknown, headers: Record<string, string> = { 'x-partner-id': 'arom' }) {
  return { method: 'POST', header: (name: string) => headers[name], body }
}
function fakeRes() {
  return { statusCode: 0, body: undefined as any, status(c: number) { this.statusCode = c; return this }, send(b: unknown) { this.body = b }, json(b: unknown) { this.body = b } }
}
function storedUrl(objectPath: string) {
  return `https://storage.googleapis.com/${BUCKET}/${objectPath}?X-Goog-Expires=604800&X-Goog-Signature=STALE-SIGNATURE`
}
function offer(id: string, over: Record<string, unknown> = {}): StoredOffer {
  return {
    id, partnerId: 'arom', farmerId: 'farmer-1', merchantId: 'merchant-uid-secret', source: 'api', message: 'internal note',
    externalReference: `ref-${id}`, listingId: 'l1', status: 'accepted', offerQuantityKg: 50, offerPricePerKgCdf: 800,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: `2026-09-02T00:00:0${id.length}.000Z`, invoiceId: `inv-${id}`, ...over,
  }
}
function listing(id: string, over: Record<string, unknown> = {}) {
  return {
    sellerId: 'farmer-1', sellerName: 'Jean Mbala', commodity: 'Ananas', commodityCode: 'ananas',
    province: 'Kongo Central', territory: 'Mbanza-Ngungu',
    photoUrls: [storedUrl(`listings/farmer-1/${id}/1700000000000-a.jpg`)], status: 'sold', ...over,
  }
}

const get = getExternalHarvestOffer as unknown as Handler
const list = getExternalHarvestOffers as unknown as Handler

beforeEach(() => {
  vi.clearAllMocks()
  offers = []
  filters = []
  limitN = null
  for (const k of Object.keys(listings)) delete listings[k]
  verifySigMock.mockResolvedValue(true)
  getAllMock.mockImplementation(async (...refs: { id: string }[]) =>
    refs.map((r) => ({ exists: listings[r.id] !== undefined, id: r.id, data: () => listings[r.id] })),
  )
  getSignedUrlMock.mockImplementation(async () => ['https://signed.example/fresh'])
  fileMock.mockImplementation((path: string) => ({ getSignedUrl: (o: unknown) => getSignedUrlMock(o, path) }))
})

describe('getExternalHarvestOffer — enrichment', () => {
  it('returns the base offer fields unchanged plus seller and listing for an accepted offer', async () => {
    offers = [offer('o1')]
    listings['l1'] = listing('l1')
    const res = fakeRes()
    await get(fakeReq({ offerId: 'o1' }), res)

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject(toExternalHarvestOfferDto('o1', offers[0]))
    expect(res.body.seller).toEqual({ id: 'farmer-1', displayName: 'Jean Mbala' })
    expect(res.body.listing).toMatchObject({ commodity: 'Ananas', commodityCode: 'ananas', province: 'Kongo Central', territory: 'Mbanza-Ngungu' })
    expect(res.body.listing.thumbnail.url).toBe('https://signed.example/fresh')
    expect(Number.isNaN(Date.parse(res.body.listing.thumbnail.expiresAt))).toBe(false)
  })

  it('also enriches when looked up by externalReference', async () => {
    offers = [offer('o1')]
    listings['l1'] = listing('l1')
    const res = fakeRes()
    await get(fakeReq({ externalReference: 'ref-o1' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.seller.id).toBe('farmer-1')
  })

  it.each(['pending', 'declined'])('returns null enrichment for a %s offer without reading listings', async (status) => {
    offers = [offer('o1', { status, invoiceId: null })]
    listings['l1'] = listing('l1')
    const res = fakeRes()
    await get(fakeReq({ offerId: 'o1' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ...toExternalHarvestOfferDto('o1', offers[0]), seller: null, listing: null })
    expect(getAllMock).not.toHaveBeenCalled()
  })

  it('still returns 404 for another partner\'s offer and never reads listings or signs anything', async () => {
    offers = [offer('o1', { partnerId: 'someone-else' })]
    listings['l1'] = listing('l1')
    const res = fakeRes()
    await get(fakeReq({ offerId: 'o1' }), res)
    expect(res.statusCode).toBe(404)
    expect(getAllMock).not.toHaveBeenCalled()
    expect(getSignedUrlMock).not.toHaveBeenCalled()
    expect(JSON.stringify(res.body ?? '')).not.toContain('Jean Mbala')
  })

  it('does not enrich when the signature is invalid', async () => {
    verifySigMock.mockResolvedValueOnce(false)
    offers = [offer('o1')]
    const res = fakeRes()
    await get(fakeReq({ offerId: 'o1' }), res)
    expect(res.statusCode).toBe(401)
    expect(getAllMock).not.toHaveBeenCalled()
  })

  it('returns HTTP 200 with the rest of the offer when image signing fails', async () => {
    offers = [offer('o1')]
    listings['l1'] = listing('l1')
    getSignedUrlMock.mockRejectedValue(new Error('signBlob denied'))
    const res = fakeRes()
    await get(fakeReq({ offerId: 'o1' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.offerId).toBe('o1')
    expect(res.body.status).toBe('accepted')
    expect(res.body.seller).toEqual({ id: 'farmer-1', displayName: 'Jean Mbala' })
    expect(res.body.listing.thumbnail).toBeNull()
    expect(res.body.listing.commodity).toBe('Ananas')
  })

  it('returns HTTP 200 with seller.id only when the listing read fails or the listing is gone', async () => {
    offers = [offer('o1')]
    getAllMock.mockRejectedValueOnce(new Error('unavailable'))
    const failed = fakeRes()
    await get(fakeReq({ offerId: 'o1' }), failed)
    expect(failed.statusCode).toBe(200)
    expect(failed.body.seller).toEqual({ id: 'farmer-1', displayName: null })
    expect(failed.body.listing).toBeNull()

    const gone = fakeRes()
    await get(fakeReq({ offerId: 'o1' }), gone)
    expect(gone.statusCode).toBe(200)
    expect(gone.body.seller).toEqual({ id: 'farmer-1', displayName: null })
    expect(gone.body.listing).toBeNull()
  })

  it('never serialises private fields, merchant metadata or the stale stored URL', async () => {
    offers = [offer('o1')]
    listings['l1'] = listing('l1', {
      sellerPhone: 'PRIVATE-PHONE', sellerEmail: 'PRIVATE-EMAIL', address: 'PRIVATE-ADDRESS',
      walletCdf: 555444333, fcmToken: 'PRIVATE-FCM', sellerRole: 'PRIVATE-ROLE',
    })
    const res = fakeRes()
    await get(fakeReq({ offerId: 'o1' }), res)
    const json = JSON.stringify(res.body)
    for (const s of ['PRIVATE-', '555444333', 'merchant-uid-secret', 'internal note', 'STALE-SIGNATURE', 'partnerId', 'merchantId', 'photoUrls']) {
      expect(json).not.toContain(s)
    }
  })
})

describe('getExternalHarvestOffers — enrichment', () => {
  it('enriches accepted rows only, keeps base fields and pagination unchanged, and dedups listing work', async () => {
    listings['l1'] = listing('l1')
    listings['l2'] = listing('l2')
    offers = [
      offer('a1', { listingId: 'l1', updatedAt: '2026-09-02T00:00:01.000Z' }),
      offer('a2', { listingId: 'l1', updatedAt: '2026-09-02T00:00:02.000Z' }),
      offer('a3', { listingId: 'l2', updatedAt: '2026-09-02T00:00:03.000Z' }),
      offer('p1', { listingId: 'l3', status: 'pending', invoiceId: null, updatedAt: '2026-09-02T00:00:04.000Z' }),
      offer('d1', { listingId: 'l4', status: 'declined', invoiceId: null, updatedAt: '2026-09-02T00:00:05.000Z' }),
    ]
    const res = fakeRes()
    await list(fakeReq({ limit: 5 }), res)

    expect(res.statusCode).toBe(200)
    expect(res.body.offers).toHaveLength(5)
    for (const row of res.body.offers) {
      const stored = offers.find((o) => o.id === row.offerId)!
      expect(row).toMatchObject(toExternalHarvestOfferDto(stored.id, stored))
    }
    expect(res.body.offers.map((o: any) => o.seller !== null)).toEqual([true, true, true, false, false])
    expect(res.body.offers.map((o: any) => o.listing !== null)).toEqual([true, true, true, false, false])

    // Listing reads deduplicated to one batch of two distinct accepted listings; declined/pending listings never read.
    expect(getAllMock).toHaveBeenCalledTimes(1)
    expect(getAllMock.mock.calls[0].map((r: { id: string }) => r.id).sort()).toEqual(['l1', 'l2'])
    expect(getSignedUrlMock).toHaveBeenCalledTimes(2)

    // Cursor still derived from the last base row (limit reached).
    expect(res.body.nextCursor).toBe(
      Buffer.from(JSON.stringify({ updatedAt: '2026-09-02T00:00:05.000Z', id: 'd1' })).toString('base64url'),
    )
  })

  it('does no listing work at all for a page of pending and declined offers', async () => {
    offers = [
      offer('p1', { status: 'pending', invoiceId: null }),
      offer('d1', { status: 'declined', invoiceId: null, updatedAt: '2026-09-02T00:00:09.000Z' }),
    ]
    const res = fakeRes()
    await list(fakeReq({}), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.offers.every((o: any) => o.seller === null && o.listing === null)).toBe(true)
    expect(getAllMock).not.toHaveBeenCalled()
    expect(getSignedUrlMock).not.toHaveBeenCalled()
  })

  it('takes each row\'s seller.id from that row\'s own offer', async () => {
    listings['l1'] = listing('l1')
    listings['l2'] = listing('l2', { sellerId: 'farmer-2', sellerName: 'Marie Kasa', photoUrls: [storedUrl('listings/farmer-2/l2/1-a.jpg')] })
    offers = [
      offer('a1', { listingId: 'l1', farmerId: 'farmer-1', updatedAt: '2026-09-02T00:00:01.000Z' }),
      offer('a2', { listingId: 'l2', farmerId: 'farmer-2', updatedAt: '2026-09-02T00:00:02.000Z' }),
    ]
    const res = fakeRes()
    await list(fakeReq({}), res)
    expect(res.body.offers.map((o: any) => o.seller)).toEqual([
      { id: 'farmer-1', displayName: 'Jean Mbala' },
      { id: 'farmer-2', displayName: 'Marie Kasa' },
    ])
  })

  it('returns HTTP 200 with every row intact when signing fails for the whole page', async () => {
    listings['l1'] = listing('l1')
    offers = [offer('a1'), offer('a2', { updatedAt: '2026-09-02T00:00:09.000Z' })]
    getSignedUrlMock.mockRejectedValue(new Error('quota'))
    const res = fakeRes()
    await list(fakeReq({}), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.offers).toHaveLength(2)
    expect(res.body.offers.map((o: any) => o.listing.thumbnail)).toEqual([null, null])
  })

  it('still returns only the caller\'s offers and never enriches another partner\'s', async () => {
    listings['l1'] = listing('l1')
    offers = [offer('mine'), offer('theirs', { partnerId: 'someone-else', updatedAt: '2026-09-02T00:00:09.000Z' })]
    const res = fakeRes()
    await list(fakeReq({}), res)
    expect(res.body.offers.map((o: any) => o.offerId)).toEqual(['mine'])
    expect(JSON.stringify(res.body)).not.toContain('someone-else')
  })
})
