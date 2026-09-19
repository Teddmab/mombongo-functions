import { Timestamp } from 'firebase-admin/firestore'
import { db, functions } from '../lib/admin'
import { verifyPartnerSignature } from './verifyPartnerSignature'
import { enrichExternalHarvestOffers } from './externalHarvestOfferEnrichment'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const VALID_STATUSES = ['pending', 'accepted', 'declined']

/**
 * Opaque cursor = base64(JSON({updatedAt: ISO string, id: string})) — the
 * last row of the previous page. Ordering is (updatedAt asc, __name__ asc)
 * so pagination is stable even if two offers share the same updatedAt
 * (server timestamps have limited resolution and two offers created in
 * the same batch write could tie) — __name__ (document id) as a tiebreaker
 * guarantees a strict total order, which a bare updatedAt-only cursor
 * cannot: without it, ties could be skipped or repeated across pages.
 */
interface Cursor {
  updatedAt: string
  id: string
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url')
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (typeof parsed?.updatedAt === 'string' && typeof parsed?.id === 'string') return parsed
    return null
  } catch {
    return null
  }
}

/**
 * Paginated list of the authenticated partner's own offers — never
 * another partner's. partnerId always comes from the verified
 * x-partner-id header, never from the request body, so there is no
 * client-suppliable field that could widen the query past that partner's
 * own offers.
 *
 * Ordered oldest-changed-first (updatedAt asc) — this is a reconciliation
 * feed meant to be paged forward in time from a cursor, not a "most
 * recent activity" browse view. updatedSince + this ordering compose
 * naturally: request updatedSince=<last seen>, page through everything
 * newer than that in a stable, resumable order.
 */
export const getExternalHarvestOffers = functions
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

    const { status, updatedSince, limit: rawLimit, cursor: rawCursor } = (req.body ?? {}) as {
      status?: string
      updatedSince?: string
      limit?: number
      cursor?: string
    }

    if (status && !VALID_STATUSES.includes(status)) {
      res.status(400).send(`status must be one of ${VALID_STATUSES.join(', ')}`)
      return
    }
    let updatedSinceDate: Date | null = null
    if (updatedSince) {
      updatedSinceDate = new Date(updatedSince)
      if (Number.isNaN(updatedSinceDate.getTime())) {
        res.status(400).send('updatedSince must be a valid ISO 8601 timestamp')
        return
      }
    }
    let cursor: Cursor | null = null
    if (rawCursor) {
      cursor = decodeCursor(rawCursor)
      if (!cursor) {
        res.status(400).send('cursor is invalid or malformed')
        return
      }
    }
    const limit = Math.min(Math.max(1, rawLimit ?? DEFAULT_LIMIT), MAX_LIMIT)

    let q = db
      .collection('harvest_offers')
      .where('partnerId', '==', partnerId) as FirebaseFirestore.Query
    if (status) q = q.where('status', '==', status)
    if (updatedSinceDate) q = q.where('updatedAt', '>', Timestamp.fromDate(updatedSinceDate))
    q = q.orderBy('updatedAt', 'asc').orderBy('__name__', 'asc')
    if (cursor) {
      q = q.startAfter(Timestamp.fromDate(new Date(cursor.updatedAt)), cursor.id)
    }

    const snap = await q.limit(limit).get()
    const offers = await enrichExternalHarvestOffers(snap.docs.map((d) => ({ id: d.id, data: d.data() })))

    // Reuses the already-normalized DTO's updatedAt (via toExternalHarvestOfferDto's
    // own Timestamp/Date/string handling) rather than re-deriving it from the
    // raw doc — one ISO-normalization implementation, not two that could
    // silently diverge on an input shape only one of them handles.
    const lastOffer = offers[offers.length - 1]
    const nextCursor = lastOffer && offers.length === limit && lastOffer.updatedAt
      ? encodeCursor({ updatedAt: lastOffer.updatedAt, id: lastOffer.offerId })
      : null

    res.status(200).json({ offers, nextCursor })
  })
