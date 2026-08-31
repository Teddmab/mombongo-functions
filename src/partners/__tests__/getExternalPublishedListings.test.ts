import { describe, it, expect, vi, beforeEach } from 'vitest'

const listingDocs = [
  { id: 'l1', data: () => ({ commodity: 'Manioc', province: 'Kinshasa', status: 'active' }) },
]
const whereFilters: string[][] = []

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => {
      if (name !== 'product_listings') throw new Error(`unexpected collection ${name}`)
      const chain: any = {
        where: (field: string, _op: string, value: string) => {
          whereFilters.push([field, value])
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
    expect(res.body).toEqual({ listings: [{ id: 'l1', commodity: 'Manioc', province: 'Kinshasa', status: 'active' }] })
    expect(whereFilters).toEqual(
      expect.arrayContaining([
        ['status', 'active'],
        ['commodity', 'Manioc'],
        ['province', 'Kinshasa'],
      ]),
    )
  })
})
