import { db, functions } from '../lib/admin'
import { verifyPartnerSignature } from './verifyPartnerSignature'
import { createHarvestOfferCore } from '../marketplace/createHarvestOfferCore'

/**
 * Partner-API half of createHarvestOffer (SDP-01) — resolves merchantId
 * from partners/{partnerId}.merchantUid exactly the way
 * createExternalInvoiceCheckout already does, then calls the same shared
 * core with source: 'api' so validation matches the in-app path exactly.
 */
export const createExternalHarvestOffer = functions
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

    const partnerSnap = await db.collection('partners').doc(partnerId as string).get()
    const merchantUid = partnerSnap.data()?.merchantUid as string | undefined
    if (!merchantUid) {
      res.status(500).send('Partner not fully provisioned')
      return
    }

    const { listingId, offerQuantityKg, offerPricePerKgCdf, message } = (req.body ?? {}) as {
      listingId?: string
      offerQuantityKg?: number
      offerPricePerKgCdf?: number
      message?: string
    }
    if (!listingId || !offerQuantityKg || !offerPricePerKgCdf) {
      res.status(400).send('listingId, offerQuantityKg and offerPricePerKgCdf required')
      return
    }

    try {
      const { offerId } = await createHarvestOfferCore({
        listingId,
        merchantId: merchantUid,
        source: 'api',
        partnerId: partnerId as string,
        offerQuantityKg,
        offerPricePerKgCdf,
        message,
      })
      res.status(200).json({ status: 'accepted', offerId })
    } catch (err) {
      res.status(400).send(err instanceof Error ? err.message : 'Invalid offer')
    }
  })
