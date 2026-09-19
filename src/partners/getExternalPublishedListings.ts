import { db, functions } from '../lib/admin'
import { verifyPartnerSignature } from './verifyPartnerSignature'

/** Normalizes a Firestore Timestamp, JS Date, or plain string into ISO 8601 — never a raw {_seconds,_nanoseconds} shape, which isn't a documented or stable wire format for an external partner. */
function toIso(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object' && 'toDate' in (value as Record<string, unknown>)) {
    return (value as FirebaseFirestore.Timestamp).toDate().toISOString()
  }
  if (typeof value === 'string') return value
  return null
}

/**
 * Explicit external contract for a listing — deliberately not a spread of
 * the raw Firestore doc. That used to leak every internal field
 * (sellerRole, createdAt/updatedAt, and anything added to product_listings
 * in the future) to AROM with nobody having decided that was okay, and it
 * didn't match the fields actually documented in
 * mombongo-partner-api.openapi.yaml's PublishedListing schema. This is now
 * the source of truth both code and docs must match.
 */
function toPublishedListing(id: string, data: FirebaseFirestore.DocumentData) {
  return {
    id,
    commodity: (data.commodity as string) ?? null,
    province: (data.province as string) ?? null,
    territory: (data.territory as string) ?? null,
    quantityKg: (data.quantityKg as number) ?? 0,
    quality: (data.quality as string) ?? null,
    pricePerKgCdf: (data.pricePerKgCdf as number) ?? 0,
    sellerId: (data.sellerId as string) ?? null,
    sellerName: (data.sellerName as string) ?? null,
    photoUrls: (data.photoUrls as string[]) ?? [],
    description: (data.description as string) ?? '',
    availableFrom: toIso(data.availableFrom),
    availableUntil: toIso(data.availableUntil),
    status: (data.status as string) ?? null,
  }
}

/**
 * Partner-signed read of currently-published harvests — thin wrapper
 * around the same query getProductListings (onCall, in-app) already
 * runs. GET-shaped but implemented as POST for consistent HMAC-over-body
 * signing like every other partner endpoint (a GET has no body to sign).
 */
export const getExternalPublishedListings = functions
  .region('europe-west1')
  .https.onRequest(async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method not allowed')
      return
    }

    const partnerId = req.header('x-partner-id')
    const signature = req.header('x-partner-signature')
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody

    const valid = await verifyPartnerSignature(partnerId, rawBody, signature)
    if (!valid) {
      res.status(401).send('Invalid signature')
      return
    }

    const { commodity, province, limit: lim = 20 } = (req.body ?? {}) as {
      commodity?: string
      province?: string
      limit?: number
    }

    // Catalog scoping — a partner only ever sees the commodities it was
    // explicitly granted at provisioning/edit time (adminUpdatePartnerAllowedCommodities),
    // enforced here server-side regardless of what the request itself
    // asks for. null/unset means unrestricted (the behavior every partner
    // had before this existed); an empty array means nothing, never
    // "everything" — the two must not be conflated.
    const partnerSnap = await db.collection('partners').doc(partnerId as string).get()
    const allowedCommodities = partnerSnap.data()?.allowedCommodities as string[] | null | undefined

    if (Array.isArray(allowedCommodities)) {
      if (allowedCommodities.length === 0 || (commodity && !allowedCommodities.includes(commodity))) {
        res.status(200).json({ listings: [] })
        return
      }
    }

    let q = db.collection('product_listings').where('status', '==', 'active') as FirebaseFirestore.Query
    if (commodity) {
      q = q.where('commodity', '==', commodity)
    } else if (Array.isArray(allowedCommodities) && allowedCommodities.length > 0) {
      // Firestore 'in' supports at most 10 values — fine for a curated
      // per-partner catalog; revisit if a partner ever needs more.
      q = q.where('commodity', 'in', allowedCommodities.slice(0, 10))
    }
    if (province) q = q.where('province', '==', province)

    const snap = await q.orderBy('createdAt', 'desc').limit(lim).get()

    // publishListingForFarmer.ts (the agent-assisted publish path) writes
    // a different, incompatible field set — quantityDesc/pricePerUnitCdf
    // instead of quantityKg/pricePerKgCdf — so those listings have no
    // real quantityKg. Rather than show AROM a "0 kg" listing, or worse,
    // let them offer against it (createHarvestOfferCore's quantity check
    // silently no-ops against a missing quantityKg), exclude them here
    // and log for visibility. This is a pre-existing data-model gap
    // between the two publish paths, not something fixed by this change.
    const listings = snap.docs
      .filter((d) => {
        const ok = typeof d.data().quantityKg === 'number' && d.data().quantityKg > 0
        if (!ok) functions.logger.warn(`getExternalPublishedListings: excluding listing ${d.id} — no valid quantityKg (likely agent-published, incompatible schema)`)
        return ok
      })
      .map((d) => toPublishedListing(d.id, d.data()))

    res.status(200).json({ listings })
  })
