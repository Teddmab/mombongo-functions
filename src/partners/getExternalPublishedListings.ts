import { db, functions } from '../lib/admin'
import { verifyPartnerSignature } from './verifyPartnerSignature'

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

    let q = db.collection('product_listings').where('status', '==', 'active') as FirebaseFirestore.Query
    if (commodity) q = q.where('commodity', '==', commodity)
    if (province) q = q.where('province', '==', province)

    const snap = await q.orderBy('createdAt', 'desc').limit(lim).get()
    res.status(200).json({ listings: snap.docs.map((d) => ({ id: d.id, ...d.data() })) })
  })
