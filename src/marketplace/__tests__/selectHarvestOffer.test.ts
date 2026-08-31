import { describe, it, expect, vi, beforeEach } from 'vitest'

const tx = {
  get: vi.fn(),
  set: vi.fn(),
  update: vi.fn(),
}

const offers: Record<string, Record<string, unknown> | undefined> = {}

function makeDocRef(id: string, collectionName: string) {
  return {
    id,
    get: async () => ({
      exists: offers[id] !== undefined && collectionName === 'harvest_offers',
      data: () => offers[id],
      ref: makeDocRef(id, collectionName),
    }),
  }
}

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => ({
      doc: (id?: string) => makeDocRef(id ?? 'generated-id', name),
      where: () => ({ where: () => 'OTHERS_QUERY' }),
    }),
    runTransaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(tx),
  },
  functions: {
    region: vi.fn(() => ({ https: { onCall: vi.fn((h: unknown) => h) } })),
    https: {
      HttpsError: class extends Error {
        constructor(public code: string, msg: string) { super(msg) }
      },
    },
  },
}))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: vi.fn(() => 'SERVER_TIMESTAMP') },
}))

vi.mock('../../payments/initiateDeposit', () => ({
  getUsdToCdf: vi.fn(async () => 2800),
}))

import { selectHarvestOffer } from '../selectHarvestOffer'

type Handler = (data: unknown, context: { auth?: { uid: string } }) => Promise<unknown>

describe('selectHarvestOffer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const k of Object.keys(offers)) delete offers[k]
    tx.get.mockResolvedValue({ docs: [] })
  })

  it('rejects an unauthenticated caller', async () => {
    await expect((selectHarvestOffer as unknown as Handler)({ offerId: 'o1' }, {})).rejects.toThrow('Login required')
  })

  it('rejects a missing offer', async () => {
    await expect(
      (selectHarvestOffer as unknown as Handler)({ offerId: 'nope' }, { auth: { uid: 'farmer-1' } }),
    ).rejects.toThrow('Offer not found')
  })

  it("rejects selecting an offer on someone else's listing", async () => {
    offers['o1'] = { farmerId: 'farmer-2', status: 'pending', listingId: 'l1', merchantId: 'm1', offerQuantityKg: 10, offerPricePerKgCdf: 100 }
    await expect(
      (selectHarvestOffer as unknown as Handler)({ offerId: 'o1' }, { auth: { uid: 'farmer-1' } }),
    ).rejects.toThrow('Not your listing')
  })

  it('rejects an already-resolved offer', async () => {
    offers['o1'] = { farmerId: 'farmer-1', status: 'accepted', listingId: 'l1', merchantId: 'm1', offerQuantityKg: 10, offerPricePerKgCdf: 100 }
    await expect(
      (selectHarvestOffer as unknown as Handler)({ offerId: 'o1' }, { auth: { uid: 'farmer-1' } }),
    ).rejects.toThrow('already resolved')
  })

  it('creates an invoice, converting CDF to USD with the live rate', async () => {
    offers['o1'] = { farmerId: 'farmer-1', status: 'pending', listingId: 'l1', merchantId: 'm1', partnerId: null, offerQuantityKg: 10, offerPricePerKgCdf: 2800 }
    const result = await (selectHarvestOffer as unknown as Handler)({ offerId: 'o1' }, { auth: { uid: 'farmer-1' } })
    expect(result).toHaveProperty('invoiceId')
    expect(tx.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ origin: 'harvest_sale', amountUsd: 10, currency: 'USD', status: 'pending' }),
    )
  })

  it('marks the selected offer accepted and the listing sold', async () => {
    offers['o1'] = { farmerId: 'farmer-1', status: 'pending', listingId: 'l1', merchantId: 'm1', partnerId: null, offerQuantityKg: 10, offerPricePerKgCdf: 2800 }
    await (selectHarvestOffer as unknown as Handler)({ offerId: 'o1' }, { auth: { uid: 'farmer-1' } })
    expect(tx.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'o1' }), expect.objectContaining({ status: 'accepted' }))
    expect(tx.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'l1' }), { status: 'sold' })
  })

  it('declines every other pending offer on the same listing', async () => {
    offers['o1'] = { farmerId: 'farmer-1', status: 'pending', listingId: 'l1', merchantId: 'm1', partnerId: null, offerQuantityKg: 10, offerPricePerKgCdf: 2800 }
    tx.get.mockResolvedValueOnce({
      docs: [
        { id: 'o1', ref: makeDocRef('o1', 'harvest_offers') },
        { id: 'o2', ref: makeDocRef('o2', 'harvest_offers') },
      ],
    })
    await (selectHarvestOffer as unknown as Handler)({ offerId: 'o1' }, { auth: { uid: 'farmer-1' } })
    expect(tx.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'o2' }), expect.objectContaining({ status: 'declined' }))
    expect(tx.update).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'o1' }), expect.objectContaining({ status: 'declined' }))
  })

  it('reads before writing inside the transaction (Firestore requirement)', async () => {
    offers['o1'] = { farmerId: 'farmer-1', status: 'pending', listingId: 'l1', merchantId: 'm1', partnerId: null, offerQuantityKg: 10, offerPricePerKgCdf: 2800 }
    const callOrder: string[] = []
    tx.get.mockImplementationOnce(async () => { callOrder.push('get'); return { docs: [] } })
    tx.set.mockImplementationOnce(() => { callOrder.push('set') })
    tx.update.mockImplementation(() => { callOrder.push('update') })
    await (selectHarvestOffer as unknown as Handler)({ offerId: 'o1' }, { auth: { uid: 'farmer-1' } })
    expect(callOrder[0]).toBe('get')
  })
})
