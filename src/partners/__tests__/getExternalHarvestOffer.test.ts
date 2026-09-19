import { describe, it, expect, vi, beforeEach } from 'vitest'

const offers: Record<string, Record<string, unknown> | undefined> = {}
let lastQueryFilters: [string, string, unknown][] = []

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => {
      if (name !== 'harvest_offers') throw new Error(`unexpected collection ${name}`)
      const chain: any = {
        doc: (id: string) => ({ get: async () => ({ exists: offers[id] !== undefined, id, data: () => offers[id] }) }),
        where: (field: string, op: string, value: unknown) => {
          lastQueryFilters.push([field, op, value])
          return chain
        },
        limit: () => chain,
        get: async () => {
          const [, , partnerId] = lastQueryFilters.find(([f]) => f === 'partnerId') ?? []
          const [, , externalReference] = lastQueryFilters.find(([f]) => f === 'externalReference') ?? []
          const match = Object.entries(offers).find(
            ([, d]) => d?.partnerId === partnerId && d?.externalReference === externalReference,
          )
          return { empty: !match, docs: match ? [{ id: match[0], data: () => match[1] }] : [] }
        },
      }
      return chain
    },
  },
  functions: { region: vi.fn(() => ({ https: { onRequest: vi.fn((h: unknown) => h) } })) },
}))

const { verifySigMock } = vi.hoisted(() => ({ verifySigMock: vi.fn() }))
vi.mock('../verifyPartnerSignature', () => ({ verifyPartnerSignature: verifySigMock }))

import { getExternalHarvestOffer } from '../getExternalHarvestOffer'

type Handler = (req: unknown, res: unknown) => Promise<void>

function fakeReq(body: unknown, headers: Record<string, string> = { 'x-partner-id': 'arom' }) {
  return { method: 'POST', header: (name: string) => headers[name], body }
}
function fakeRes() {
  return { statusCode: 0, body: undefined as unknown, status(c: number) { this.statusCode = c; return this }, send(b: unknown) { this.body = b }, json(b: unknown) { this.body = b } }
}

describe('getExternalHarvestOffer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    lastQueryFilters = []
    for (const k of Object.keys(offers)) delete offers[k]
  })

  it('rejects an invalid signature', async () => {
    verifySigMock.mockResolvedValueOnce(false)
    const res = fakeRes()
    await (getExternalHarvestOffer as unknown as Handler)(fakeReq({ offerId: 'o1' }), res)
    expect(res.statusCode).toBe(401)
  })

  it('rejects a request with neither offerId nor externalReference', async () => {
    verifySigMock.mockResolvedValueOnce(true)
    const res = fakeRes()
    await (getExternalHarvestOffer as unknown as Handler)(fakeReq({}), res)
    expect(res.statusCode).toBe(400)
  })

  it('rejects a request with both offerId and externalReference', async () => {
    verifySigMock.mockResolvedValueOnce(true)
    const res = fakeRes()
    await (getExternalHarvestOffer as unknown as Handler)(fakeReq({ offerId: 'o1', externalReference: 'ref' }), res)
    expect(res.statusCode).toBe(400)
  })

  it('finds an offer by offerId belonging to the caller', async () => {
    offers['o1'] = { partnerId: 'arom', listingId: 'l1', status: 'pending', offerQuantityKg: 10, offerPricePerKgCdf: 100 }
    verifySigMock.mockResolvedValueOnce(true)
    const res = fakeRes()
    await (getExternalHarvestOffer as unknown as Handler)(fakeReq({ offerId: 'o1' }), res)
    expect(res.statusCode).toBe(200)
    expect((res.body as { offerId: string }).offerId).toBe('o1')
  })

  it('returns 404 (not 403) when offerId exists but belongs to a different partner — no existence leak', async () => {
    offers['o1'] = { partnerId: 'someone-else', listingId: 'l1', status: 'pending', offerQuantityKg: 10, offerPricePerKgCdf: 100 }
    verifySigMock.mockResolvedValueOnce(true)
    const res = fakeRes()
    await (getExternalHarvestOffer as unknown as Handler)(
      fakeReq({ offerId: 'o1' }, { 'x-partner-id': 'arom' }),
      res,
    )
    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for an offerId that does not exist at all', async () => {
    verifySigMock.mockResolvedValueOnce(true)
    const res = fakeRes()
    await (getExternalHarvestOffer as unknown as Handler)(fakeReq({ offerId: 'nope' }), res)
    expect(res.statusCode).toBe(404)
  })

  it('finds an offer by externalReference scoped to the caller partnerId', async () => {
    offers['o1'] = { partnerId: 'arom', externalReference: 'arom-po-1', listingId: 'l1', status: 'pending', offerQuantityKg: 10, offerPricePerKgCdf: 100 }
    verifySigMock.mockResolvedValueOnce(true)
    const res = fakeRes()
    await (getExternalHarvestOffer as unknown as Handler)(fakeReq({ externalReference: 'arom-po-1' }), res)
    expect(res.statusCode).toBe(200)
    expect((res.body as { offerId: string }).offerId).toBe('o1')
  })

  it('does not find another partner\'s offer by externalReference, even if the reference string matches', async () => {
    offers['o1'] = { partnerId: 'someone-else', externalReference: 'shared-looking-ref', listingId: 'l1', status: 'pending', offerQuantityKg: 10, offerPricePerKgCdf: 100 }
    verifySigMock.mockResolvedValueOnce(true)
    const res = fakeRes()
    await (getExternalHarvestOffer as unknown as Handler)(
      fakeReq({ externalReference: 'shared-looking-ref' }, { 'x-partner-id': 'arom' }),
      res,
    )
    expect(res.statusCode).toBe(404)
  })
})
