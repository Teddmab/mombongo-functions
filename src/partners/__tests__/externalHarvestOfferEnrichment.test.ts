import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const BUCKET = 'test-bucket'
const listings: Record<string, Record<string, unknown> | undefined> = {}
const getAllMock = vi.fn()
const getSignedUrlMock = vi.fn()
const fileMock = vi.fn()

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => {
      if (name !== 'product_listings') throw new Error(`unexpected collection ${name}`)
      return { doc: (id: string) => ({ id }) }
    },
    getAll: (...refs: { id: string }[]) => getAllMock(...refs),
  },
}))
vi.mock('firebase-admin/storage', () => ({
  getStorage: () => ({ bucket: () => ({ name: BUCKET, file: fileMock }) }),
}))
vi.mock('firebase-functions/logger', () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }))

import {
  enrichExternalHarvestOffers,
  resolveListingObjectPath,
  sanitizeDisplayName,
} from '../externalHarvestOfferEnrichment'
import { toExternalHarvestOfferDto } from '../externalHarvestOfferDto'

/**
 * Same shape getListingPhotoUploadUrl stores: V4 signed URL, path-style. The
 * object name is encoded the way @google-cloud/storage does it —
 * encodeURIComponent semantics with '/' left literal.
 */
function gcsEncode(objectPath: string) {
  return encodeURIComponent(objectPath)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/g, '/')
}
function storedUrl(objectPath: string, bucket = BUCKET, host = 'storage.googleapis.com') {
  return `https://${host}/${bucket}/${gcsEncode(objectPath)}?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Date=20200101T000000Z&X-Goog-Expires=604800&X-Goog-Signature=STALE-SIGNATURE`
}

function acceptedOffer(over: Record<string, unknown> = {}) {
  return {
    partnerId: 'arom',
    farmerId: 'farmer-1',
    merchantId: 'merchant-uid-secret',
    source: 'api',
    message: 'internal note',
    externalReference: 'arom-po-1',
    listingId: 'l1',
    status: 'accepted',
    offerQuantityKg: 50,
    offerPricePerKgCdf: 800,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    invoiceId: 'inv1',
    ...over,
  }
}

function listing(over: Record<string, unknown> = {}) {
  return {
    sellerId: 'farmer-1',
    sellerName: 'Jean Mbala',
    commodity: 'Ananas',
    commodityCode: 'ananas',
    province: 'Kongo Central',
    territory: 'Mbanza-Ngungu',
    photoUrls: [storedUrl('listings/farmer-1/l1/1700000000000-photo one.jpg')],
    status: 'sold',
    ...over,
  }
}

describe('sanitizeDisplayName', () => {
  it('trims, collapses whitespace and keeps a normal name', () => {
    expect(sanitizeDisplayName('  Jean   Mbala \n')).toBe('Jean Mbala')
    expect(sanitizeDisplayName('Élise Kabila-Nsimba')).toBe('Élise Kabila-Nsimba')
  })

  it('caps at 80 characters without splitting a character', () => {
    const out = sanitizeDisplayName('é'.repeat(200))!
    expect(Array.from(out)).toHaveLength(80)
    expect(sanitizeDisplayName('😀'.repeat(100))!.length).toBe(160)
  })

  it.each([
    ['Vendeur'], ['vendeur'], ['  AGRICULTEUR '], ['Agriculteur'],
    [''], ['   '], [null], [undefined], [42], [{}],
    ['jean@example.com'], ['contact: a@b.cd'],
    ['+243 812 345 678'], ['0812345678'], ['Jean 0812345678'],
  ])('returns null for %j', (raw) => {
    expect(sanitizeDisplayName(raw)).toBeNull()
  })

  it('does not treat a few digits as a phone number', () => {
    expect(sanitizeDisplayName('Coopérative 2 Rives')).toBe('Coopérative 2 Rives')
  })
  // Control characters are built with fromCharCode on purpose: this file must stay plain text.
  it.each([0x00, 0x01, 0x08, 0x0b, 0x1f, 0x7f])('replaces control character code %i inside a name with a space', (code) => {
    const c = String.fromCharCode(code)
    expect(sanitizeDisplayName(`Jean${c}Mbala`)).toBe('Jean Mbala')
    expect(sanitizeDisplayName(`${c}Jean Mbala${c}`)).toBe('Jean Mbala')
  })

  it('returns null for a value made only of control characters', () => {
    expect(sanitizeDisplayName(String.fromCharCode(0, 1, 0x1f, 0x7f))).toBeNull()
  })
})

describe('resolveListingObjectPath', () => {
  const ctx = { bucketName: BUCKET, sellerId: 'farmer-1', listingId: 'l1' }

  it('resolves a stored, even long-expired, signed URL to its object path', () => {
    expect(resolveListingObjectPath(storedUrl('listings/farmer-1/l1/1700000000000-photo one.jpg'), ctx))
      .toBe('listings/farmer-1/l1/1700000000000-photo one.jpg')
  })

  it('handles unicode and reserved characters in the client-supplied file name', () => {
    const p = 'listings/farmer-1/l1/1700000000000-Ananas récolte #2 (a?b).jpg'
    expect(resolveListingObjectPath(storedUrl(p), ctx)).toBe(p)
  })

  it.each([
    ['other seller', 'listings/farmer-2/l1/1-a.jpg'],
    ['other listing', 'listings/farmer-1/l2/1-a.jpg'],
    ['no listings prefix', 'kyc/farmer-1/l1/1-a.jpg'],
    ['prefix only', 'listings/farmer-1/l1/'],
    ['sibling prefix', 'listings/farmer-1/l10/1-a.jpg'],
    ['seller prefix collision', 'listings/farmer-11/l1/1-a.jpg'],
    ['literal dot-dot that escapes the listing', 'listings/farmer-1/l1/../l2/1-a.jpg'],
    ['empty segment', 'listings/farmer-1/l1//1-a.jpg'],
  ])('rejects %s', (_label, path) => {
    expect(resolveListingObjectPath(storedUrl(path), ctx)).toBeNull()
  })

  it('normalises a literal dot segment and signs only the validated, normalised path', () => {
    // The URL parser collapses /./ before validation; what is signed is exactly the string validated.
    expect(resolveListingObjectPath(storedUrl('listings/farmer-1/l1/./1-a.jpg'), ctx)).toBe('listings/farmer-1/l1/1-a.jpg')
  })

  it('rejects a traversal hidden in %2F, which only appears after decoding', () => {
    const raw = (p: string) => `https://storage.googleapis.com/${BUCKET}/${p}?X-Goog-Signature=x`
    expect(resolveListingObjectPath(raw('listings/farmer-1/l1%2F..%2F..%2Ffarmer-2%2Fsecret.jpg'), ctx)).toBeNull()
    expect(resolveListingObjectPath(raw('listings/farmer-1/l1%2F..%2Fl1%2F1-a.jpg'), ctx)).toBeNull()
    expect(resolveListingObjectPath(raw('listings/farmer-1/l1%2F.%2F1-a.jpg'), ctx)).toBeNull()
  })

  it('rejects an encoded traversal and a control character', () => {
    expect(resolveListingObjectPath(`https://storage.googleapis.com/${BUCKET}/listings/farmer-1/l1/%2e%2e/x.jpg`, ctx)).toBeNull()
    expect(resolveListingObjectPath(`https://storage.googleapis.com/${BUCKET}/listings/farmer-1/l1/a%00b.jpg`, ctx)).toBeNull()
    expect(resolveListingObjectPath(`https://storage.googleapis.com/${BUCKET}/listings%2Ffarmer-2%2Fl1%2F1-a.jpg`, ctx)).toBeNull()
  })

  it('rejects another bucket, another host, http, and malformed input', () => {
    const good = 'listings/farmer-1/l1/1-a.jpg'
    expect(resolveListingObjectPath(storedUrl(good, 'other-bucket'), ctx)).toBeNull()
    expect(resolveListingObjectPath(storedUrl(good, BUCKET, 'evil.example.com'), ctx)).toBeNull()
    expect(resolveListingObjectPath(storedUrl(good).replace('https:', 'http:'), ctx)).toBeNull()
    expect(resolveListingObjectPath(`https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(good)}?alt=media&token=t`, ctx)).toBeNull()
    expect(resolveListingObjectPath('not a url', ctx)).toBeNull()
    expect(resolveListingObjectPath(undefined, ctx)).toBeNull()
    expect(resolveListingObjectPath(42, ctx)).toBeNull()
    expect(resolveListingObjectPath(`https://storage.googleapis.com/${BUCKET}`, ctx)).toBeNull()
  })

  it('refuses ids that could widen the prefix', () => {
    const url = storedUrl('listings/a/b/l1/1-a.jpg')
    expect(resolveListingObjectPath(url, { ...ctx, sellerId: 'a/b' })).toBeNull()
    expect(resolveListingObjectPath(url, { ...ctx, sellerId: '' })).toBeNull()
    expect(resolveListingObjectPath(url, { ...ctx, listingId: '' })).toBeNull()
  })
  // Every C0 control except tab/LF/CR (which the URL parser strips before we see them) and DEL, as a literal
  // character and percent-encoded: both must be rejected. Built with fromCharCode — this file must stay plain text.
  const CONTROL_CODES = [...Array.from({ length: 0x20 }, (_, i) => i).filter((i) => ![0x09, 0x0a, 0x0d].includes(i)), 0x7f]
  const withName = (name: string) => `https://storage.googleapis.com/${BUCKET}/listings/farmer-1/l1/${name}?X-Goog-Signature=x`

  it.each(CONTROL_CODES)('rejects a LITERAL control character code %i in the object name', (code) => {
    expect(resolveListingObjectPath(withName(`a${String.fromCharCode(code)}b.jpg`), ctx)).toBeNull()
  })

  it.each(CONTROL_CODES)('rejects a PERCENT-ENCODED control character code %i in the object name', (code) => {
    expect(resolveListingObjectPath(withName(`a%${code.toString(16).padStart(2, '0')}b.jpg`), ctx)).toBeNull()
  })

  it('rejects a literal NUL anywhere in the path, including the prefix', () => {
    const nul = String.fromCharCode(0)
    expect(resolveListingObjectPath(`https://storage.googleapis.com/${BUCKET}/listings/farmer-1/l1/${nul}`, ctx)).toBeNull()
    expect(resolveListingObjectPath(`https://storage.googleapis.com/${BUCKET}/listings/farmer-1${nul}/l1/1-a.jpg`, ctx)).toBeNull()
    expect(resolveListingObjectPath(withName(`1-a.jpg${nul}`), ctx)).toBeNull()
  })

  it('still rejects percent-encoded traversal (single and mixed-case encodings, and a decoded %2F separator)', () => {
    for (const p of ['%2e%2e/x.jpg', '%2E%2E/x.jpg', '.%2e/x.jpg', '%2e./x.jpg', '..%2Fx.jpg', 'a%2F..%2F..%2Fx.jpg']) {
      expect(resolveListingObjectPath(withName(p), ctx)).toBeNull()
    }
  })

  it('accepts a realistic path in the development bucket', () => {
    const devCtx = { bucketName: 'mombongo-dev.firebasestorage.app', sellerId: 'Kq3ZxY0fWmN8pLr2VbTd5cHu7AeS', listingId: 'a1B2c3D4e5F6g7H8i9J0' }
    const object = `listings/${devCtx.sellerId}/${devCtx.listingId}/1758412800000-Ananas récolte 2.jpg`
    expect(resolveListingObjectPath(storedUrl(object, devCtx.bucketName), devCtx)).toBe(object)
    // and the same URL is refused for any other bucket
    expect(resolveListingObjectPath(storedUrl(object, devCtx.bucketName), { ...devCtx, bucketName: 'some-other-project.firebasestorage.app' })).toBeNull()
  })

  it('pins the URL parser normalisation: tab/LF/CR are stripped before validation, so only the validated path is signed', () => {
    expect(resolveListingObjectPath(withName(`1-${String.fromCharCode(9)}a${String.fromCharCode(10)}.jpg`), ctx)).toBe('listings/farmer-1/l1/1-a.jpg')
  })
})

describe('enrichExternalHarvestOffers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const k of Object.keys(listings)) delete listings[k]
    getAllMock.mockImplementation(async (...refs: { id: string }[]) =>
      refs.map((r) => ({ exists: listings[r.id] !== undefined, id: r.id, data: () => listings[r.id] })),
    )
    getSignedUrlMock.mockImplementation(async (opts: { expires: number }) => [`https://signed.example/fresh?exp=${opts.expires}`])
    fileMock.mockImplementation((path: string) => ({ getSignedUrl: (o: unknown) => getSignedUrlMock(o, path) }))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-20T10:00:00.500Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('adds seller and listing to an accepted offer and keeps every base field unchanged', async () => {
    listings['l1'] = listing()
    const data = acceptedOffer()
    const [out] = await enrichExternalHarvestOffers([{ id: 'o1', data }])

    expect(out).toEqual({
      ...toExternalHarvestOfferDto('o1', data),
      seller: { id: 'farmer-1', displayName: 'Jean Mbala' },
      listing: {
        commodity: 'Ananas',
        commodityCode: 'ananas',
        province: 'Kongo Central',
        territory: 'Mbanza-Ngungu',
        thumbnail: {
          url: 'https://signed.example/fresh?exp=1789902000000',
          expiresAt: '2026-09-20T11:00:00.000Z',
        },
      },
    })
    expect(Object.keys(out).sort()).toEqual(
      ['offerId', 'externalReference', 'listingId', 'status', 'quantityKg', 'unitPriceCdf', 'currency', 'createdAt', 'updatedAt', 'invoiceId', 'seller', 'listing'].sort(),
    )
  })

  it('signs a fresh 1h V4 read URL for the resolved object path, ignoring the stale stored URL', async () => {
    listings['l1'] = listing()
    const [out] = await enrichExternalHarvestOffers([{ id: 'o1', data: acceptedOffer() }])

    expect(getSignedUrlMock).toHaveBeenCalledTimes(1)
    expect(getSignedUrlMock).toHaveBeenCalledWith(
      { version: 'v4', action: 'read', expires: Date.parse('2026-09-20T11:00:00.000Z') },
      'listings/farmer-1/l1/1700000000000-photo one.jpg',
    )
    expect(JSON.stringify(out)).not.toContain('STALE-SIGNATURE')
    expect(out.listing?.thumbnail?.expiresAt).toBe('2026-09-20T11:00:00.000Z')
  })

  it.each(['pending', 'declined'])('gives a %s offer seller: null / listing: null with no reads or signing', async (status) => {
    listings['l1'] = listing()
    const data = acceptedOffer({ status, invoiceId: null })
    const [out] = await enrichExternalHarvestOffers([{ id: 'o1', data }])

    expect(out).toEqual({ ...toExternalHarvestOfferDto('o1', data), seller: null, listing: null })
    expect(getAllMock).not.toHaveBeenCalled()
    expect(getSignedUrlMock).not.toHaveBeenCalled()
  })

  it('takes seller.id from the offer itself, not from the listing', async () => {
    listings['l1'] = listing({ sellerId: 'farmer-1' })
    const rows = [
      { id: 'o1', data: acceptedOffer({ farmerId: 'farmer-1' }) },
      { id: 'o2', data: acceptedOffer({ farmerId: 'farmer-2' }) },
    ]
    const [a, b] = await enrichExternalHarvestOffers(rows)

    expect(a.seller).toEqual({ id: 'farmer-1', displayName: 'Jean Mbala' })
    // o2's farmer does not own l1: its own id is kept, but no name/listing/photo from a listing that isn't theirs.
    expect(b.seller).toEqual({ id: 'farmer-2', displayName: null })
    expect(b.listing).toBeNull()
    expect(getSignedUrlMock).toHaveBeenCalledTimes(1)
  })

  it('keeps seller.id and nulls the rest when the listing no longer exists', async () => {
    const [out] = await enrichExternalHarvestOffers([{ id: 'o1', data: acceptedOffer() }])
    expect(out.seller).toEqual({ id: 'farmer-1', displayName: null })
    expect(out.listing).toBeNull()
    expect(getSignedUrlMock).not.toHaveBeenCalled()
  })

  it('returns seller: null when the offer has no snapshotted farmer id (never fabricates one)', async () => {
    listings['l1'] = listing()
    const [out] = await enrichExternalHarvestOffers([{ id: 'o1', data: acceptedOffer({ farmerId: undefined }) }])
    expect(out.seller).toBeNull()
    expect(out.listing).toBeNull()
  })

  it('maps commodity and stored commodityCode, and never derives a code from free text', async () => {
    listings['l1'] = listing({ commodity: '  Maïs blanc ', commodityCode: undefined, territory: '', province: '  ' })
    const [out] = await enrichExternalHarvestOffers([{ id: 'o1', data: acceptedOffer() }])
    expect(out.listing).toMatchObject({ commodity: 'Maïs blanc', commodityCode: null, province: null, territory: null })
  })

  it('sanitises the seller name from the listing', async () => {
    listings['l1'] = listing({ sellerName: 'Vendeur' })
    listings['l2'] = listing({ sellerName: 'jean@x.cd' })
    listings['l3'] = listing({ sellerName: '0812345678' })
    const rows = ['l1', 'l2', 'l3'].map((l, i) => ({ id: `o${i}`, data: acceptedOffer({ listingId: l }) }))
    const out = await enrichExternalHarvestOffers(rows)
    expect(out.map((o) => o.seller)).toEqual(Array(3).fill({ id: 'farmer-1', displayName: null }))
    expect(out.every((o) => o.listing !== null)).toBe(true)
  })

  it('returns thumbnail: null when the listing has no photos', async () => {
    listings['l1'] = listing({ photoUrls: [] })
    listings['l2'] = listing({ photoUrls: undefined })
    const out = await enrichExternalHarvestOffers([
      { id: 'o1', data: acceptedOffer() },
      { id: 'o2', data: acceptedOffer({ listingId: 'l2' }) },
    ])
    expect(out.map((o) => o.listing?.thumbnail)).toEqual([null, null])
    expect(out[0].listing?.commodity).toBe('Ananas')
    expect(getSignedUrlMock).not.toHaveBeenCalled()
  })

  it('never signs a path outside listings/{sellerId}/{listingId}/, even if the stored document is tampered with', async () => {
    listings['l1'] = listing({
      photoUrls: [
        storedUrl('listings/farmer-2/l1/1-a.jpg'),
        storedUrl('kyc/farmer-1/id-card.jpg'),
        storedUrl('listings/farmer-1/l1/../../farmer-2/secret.jpg'),
        storedUrl('listings/farmer-1/l1/1-a.jpg', 'other-bucket'),
      ],
    })
    const [out] = await enrichExternalHarvestOffers([{ id: 'o1', data: acceptedOffer() }])
    expect(out.listing?.thumbnail).toBeNull()
    expect(fileMock).not.toHaveBeenCalled()
    expect(getSignedUrlMock).not.toHaveBeenCalled()
  })

  it('skips invalid entries and uses the first valid image', async () => {
    listings['l1'] = listing({
      photoUrls: [storedUrl('listings/farmer-2/l1/1-a.jpg'), 'garbage', 42, storedUrl('listings/farmer-1/l1/2-b.jpg'), storedUrl('listings/farmer-1/l1/3-c.jpg')],
    })
    const [out] = await enrichExternalHarvestOffers([{ id: 'o1', data: acceptedOffer() }])
    expect(fileMock).toHaveBeenCalledTimes(1)
    expect(fileMock).toHaveBeenCalledWith('listings/farmer-1/l1/2-b.jpg')
    expect(out.listing?.thumbnail?.url).toContain('signed.example')
  })

  it('degrades to thumbnail: null when signing fails, keeping everything else', async () => {
    listings['l1'] = listing()
    getSignedUrlMock.mockRejectedValue(new Error('signBlob permission denied'))
    const [out] = await enrichExternalHarvestOffers([{ id: 'o1', data: acceptedOffer() }])
    expect(out.seller).toEqual({ id: 'farmer-1', displayName: 'Jean Mbala' })
    expect(out.listing).toEqual({ commodity: 'Ananas', commodityCode: 'ananas', province: 'Kongo Central', territory: 'Mbanza-Ngungu', thumbnail: null })
  })

  it('degrades to seller.id only when the listing read itself fails', async () => {
    getAllMock.mockRejectedValue(new Error('unavailable'))
    const [out] = await enrichExternalHarvestOffers([{ id: 'o1', data: acceptedOffer() }])
    expect(out.seller).toEqual({ id: 'farmer-1', displayName: null })
    expect(out.listing).toBeNull()
    expect(out.offerId).toBe('o1')
  })

  it('reads each listing once and signs once per listing across many offers', async () => {
    listings['l1'] = listing()
    listings['l2'] = listing({ photoUrls: [storedUrl('listings/farmer-1/l2/1-a.jpg')] })
    const rows = [
      { id: 'o1', data: acceptedOffer({ listingId: 'l1' }) },
      { id: 'o2', data: acceptedOffer({ listingId: 'l1' }) },
      { id: 'o3', data: acceptedOffer({ listingId: 'l2' }) },
      { id: 'o4', data: acceptedOffer({ listingId: 'l1' }) },
    ]
    const out = await enrichExternalHarvestOffers(rows)

    expect(getAllMock).toHaveBeenCalledTimes(1)
    expect(getAllMock.mock.calls[0].map((r: { id: string }) => r.id).sort()).toEqual(['l1', 'l2'])
    expect(getSignedUrlMock).toHaveBeenCalledTimes(2)
    expect(out.map((o) => o.offerId)).toEqual(['o1', 'o2', 'o3', 'o4'])
    expect(out[0].listing?.thumbnail).toEqual(out[1].listing?.thumbnail)
  })

  it('only reads listings for accepted offers in a mixed page', async () => {
    listings['l1'] = listing()
    listings['l9'] = listing()
    const rows = [
      { id: 'o1', data: acceptedOffer({ listingId: 'l1' }) },
      { id: 'o2', data: acceptedOffer({ listingId: 'l9', status: 'pending', invoiceId: null }) },
      { id: 'o3', data: acceptedOffer({ listingId: 'l9', status: 'declined', invoiceId: null }) },
    ]
    const out = await enrichExternalHarvestOffers(rows)
    expect(getAllMock.mock.calls[0].map((r: { id: string }) => r.id)).toEqual(['l1'])
    expect(out.map((o) => o.seller !== null)).toEqual([true, false, false])
  })

  it('does not touch the listing store for an empty page', async () => {
    expect(await enrichExternalHarvestOffers([])).toEqual([])
    expect(getAllMock).not.toHaveBeenCalled()
  })

  it('never puts private farmer, merchant or listing fields anywhere in the serialised output', async () => {
    listings['l1'] = listing({
      sellerPhone: 'PRIVATE-PHONE-+243811111111',
      sellerEmail: 'PRIVATE-EMAIL@example.com',
      address: 'PRIVATE-ADDRESS-12 avenue',
      walletCdf: 987654321,
      fcmToken: 'PRIVATE-FCM-TOKEN',
      sellerRole: 'PRIVATE-ROLE',
      description: 'PRIVATE-DESCRIPTION',
      publishedByAgentId: 'PRIVATE-AGENT',
      pawapayMsisdn: 'PRIVATE-MSISDN',
      quality: 'A',
      pricePerKgCdf: 111222,
    })
    const [out] = await enrichExternalHarvestOffers([{ id: 'o1', data: acceptedOffer({ phone: 'PRIVATE-OFFER-PHONE' }) }])
    const json = JSON.stringify(out)
    for (const secret of [
      'PRIVATE-', 'merchant-uid-secret', 'internal note', 'STALE-SIGNATURE', '987654321', '111222',
      'partnerId', 'merchantId', 'photoUrls', 'walletCdf', 'fcmToken', 'sellerRole',
    ]) {
      expect(json).not.toContain(secret)
    }
    expect(Object.keys(out.seller!).sort()).toEqual(['displayName', 'id'])
    expect(Object.keys(out.listing!).sort()).toEqual(['commodity', 'commodityCode', 'province', 'territory', 'thumbnail'])
  })

  it('keeps two (listing, seller) pairs apart even when their ids concatenate to the same string', async () => {
    // 'ab'+'c' and 'a'+'bc' are equal without a separator; the internal key must not merge them.
    listings['ab'] = listing({ sellerId: 'c', commodity: 'Ananas-ab', photoUrls: [storedUrl('listings/c/ab/1-a.jpg')] })
    listings['a'] = listing({ sellerId: 'bc', commodity: 'Ananas-a', photoUrls: [storedUrl('listings/bc/a/1-a.jpg')] })
    const out = await enrichExternalHarvestOffers([
      { id: 'o1', data: acceptedOffer({ farmerId: 'c', listingId: 'ab' }) },
      { id: 'o2', data: acceptedOffer({ farmerId: 'bc', listingId: 'a' }) },
    ])
    expect(out.map((o) => o.listing?.commodity)).toEqual(['Ananas-ab', 'Ananas-a'])
    expect(out.map((o) => o.seller?.id)).toEqual(['c', 'bc'])
    expect(fileMock.mock.calls.map((c) => c[0]).sort()).toEqual(['listings/bc/a/1-a.jpg', 'listings/c/ab/1-a.jpg'])
  })

  it('serialises an accepted offer to exactly this JSON (golden — any drift in the accepted-offer contract fails here)', async () => {
    listings['l1'] = listing()
    const [out] = await enrichExternalHarvestOffers([{ id: 'o1', data: acceptedOffer() }])
    expect(JSON.stringify(out)).toBe(
      '{"offerId":"o1","externalReference":"arom-po-1","listingId":"l1","status":"accepted","quantityKg":50,"unitPriceCdf":800,"currency":"CDF",' +
        '"createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-02T00:00:00.000Z","invoiceId":"inv1",' +
        '"seller":{"id":"farmer-1","displayName":"Jean Mbala"},' +
        '"listing":{"commodity":"Ananas","commodityCode":"ananas","province":"Kongo Central","territory":"Mbanza-Ngungu",' +
        '"thumbnail":{"url":"https://signed.example/fresh?exp=1789902000000","expiresAt":"2026-09-20T11:00:00.000Z"}}}',
    )
  })

  it('ignores a listing photo whose object name contains a control character, and falls through to the next valid one', async () => {
    listings['l1'] = listing({
      photoUrls: [`https://storage.googleapis.com/${BUCKET}/listings/farmer-1/l1/a${String.fromCharCode(0)}b.jpg?X-Goog-Signature=x`, storedUrl('listings/farmer-1/l1/2-ok.jpg')],
    })
    const [out] = await enrichExternalHarvestOffers([{ id: 'o1', data: acceptedOffer() }])
    expect(fileMock).toHaveBeenCalledTimes(1)
    expect(fileMock).toHaveBeenCalledWith('listings/farmer-1/l1/2-ok.jpg')
    expect(out.listing?.thumbnail?.url).toContain('signed.example')
  })
})
