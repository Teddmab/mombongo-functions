import { describe, it, expect, vi, beforeEach } from 'vitest'

const partners: Record<string, Record<string, unknown> | undefined> = {}

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => {
      if (name !== 'partners') throw new Error(`unexpected collection ${name}`)
      return { doc: (id: string) => ({ get: async () => ({ data: () => partners[id] }) }) }
    },
  },
  functions: {
    region: vi.fn(() => ({ https: { onRequest: vi.fn((h: unknown) => h) } })),
  },
}))

const { verifySigMock, coreMock } = vi.hoisted(() => ({ verifySigMock: vi.fn(), coreMock: vi.fn() }))
vi.mock('../verifyPartnerSignature', () => ({ verifyPartnerSignature: verifySigMock }))
vi.mock('../../marketplace/createHarvestOfferCore', () => ({ createHarvestOfferCore: coreMock }))

import { createExternalHarvestOffer } from '../createExternalHarvestOffer'

type Handler = (req: unknown, res: unknown) => Promise<void>

function fakeReq(body: unknown, headers: Record<string, string> = { 'x-partner-id': 'arom' }) {
  return { method: 'POST', header: (name: string) => headers[name], body }
}

function fakeRes() {
  const res = { statusCode: 0, body: undefined as unknown, status(c: number) { this.statusCode = c; return this }, send(b: unknown) { this.body = b }, json(b: unknown) { this.body = b } }
  return res
}

describe('createExternalHarvestOffer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const k of Object.keys(partners)) delete partners[k]
  })

  it('rejects an invalid signature', async () => {
    verifySigMock.mockResolvedValueOnce(false)
    const res = fakeRes()
    await (createExternalHarvestOffer as unknown as Handler)(fakeReq({}), res)
    expect(res.statusCode).toBe(401)
  })

  it('fails closed when the partner has no merchantUid provisioned', async () => {
    verifySigMock.mockResolvedValueOnce(true)
    partners['arom'] = { name: 'AROM' } // no merchantUid
    const res = fakeRes()
    await (createExternalHarvestOffer as unknown as Handler)(
      fakeReq({ listingId: 'l1', offerQuantityKg: 10, offerPricePerKgCdf: 100 }),
      res,
    )
    expect(res.statusCode).toBe(500)
  })

  it('rejects missing required fields', async () => {
    verifySigMock.mockResolvedValueOnce(true)
    partners['arom'] = { merchantUid: 'merchant-arom' }
    const res = fakeRes()
    await (createExternalHarvestOffer as unknown as Handler)(fakeReq({ listingId: 'l1' }), res)
    expect(res.statusCode).toBe(400)
  })

  it('calls createHarvestOfferCore with source api and merchantId = partner merchantUid', async () => {
    verifySigMock.mockResolvedValueOnce(true)
    partners['arom'] = { merchantUid: 'merchant-arom' }
    coreMock.mockResolvedValueOnce({ offerId: 'offer-1' })
    const res = fakeRes()
    await (createExternalHarvestOffer as unknown as Handler)(
      fakeReq({ listingId: 'l1', offerQuantityKg: 10, offerPricePerKgCdf: 100 }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ status: 'accepted', offerId: 'offer-1' })
    expect(coreMock).toHaveBeenCalledWith(
      expect.objectContaining({ merchantId: 'merchant-arom', source: 'api', partnerId: 'arom' }),
    )
  })

  it('surfaces createHarvestOfferCore validation errors as 400', async () => {
    verifySigMock.mockResolvedValueOnce(true)
    partners['arom'] = { merchantUid: 'merchant-arom' }
    coreMock.mockRejectedValueOnce(new Error('Listing not found or not open for offers'))
    const res = fakeRes()
    await (createExternalHarvestOffer as unknown as Handler)(
      fakeReq({ listingId: 'l1', offerQuantityKg: 10, offerPricePerKgCdf: 100 }),
      res,
    )
    expect(res.statusCode).toBe(400)
  })
})
