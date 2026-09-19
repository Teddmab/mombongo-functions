import { db, functions } from '../lib/admin'
import { verifyPartnerSignature } from './verifyPartnerSignature'
import { toExternalHarvestOfferDto } from './externalHarvestOfferDto'

/**
 * Reconciliation lookup — how AROM recovers when a createExternalHarvestOffer
 * response was lost (timeout, connection reset) after Mombongo already
 * committed the offer, without resubmitting. Exactly one of offerId or
 * externalReference must be supplied.
 *
 * Partner isolation is enforced here, not left to the caller: a lookup by
 * offerId that resolves to a DIFFERENT partner's offer returns 404 (not
 * 403) — same non-descriptive-failure convention as verifyPartnerSignature,
 * so a guessed/leaked offerId can't be used to probe whether it exists at
 * all for another partner.
 */
export const getExternalHarvestOffer = functions
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

    const { offerId, externalReference } = (req.body ?? {}) as { offerId?: string; externalReference?: string }
    if ((!offerId && !externalReference) || (offerId && externalReference)) {
      res.status(400).send('Exactly one of offerId or externalReference is required')
      return
    }

    if (offerId) {
      const snap = await db.collection('harvest_offers').doc(offerId).get()
      if (!snap.exists || snap.data()?.partnerId !== partnerId) {
        res.status(404).send('Offer not found')
        return
      }
      res.status(200).json(toExternalHarvestOfferDto(snap.id, snap.data()!))
      return
    }

    const querySnap = await db
      .collection('harvest_offers')
      .where('partnerId', '==', partnerId)
      .where('externalReference', '==', externalReference)
      .limit(1)
      .get()

    if (querySnap.empty) {
      res.status(404).send('Offer not found')
      return
    }

    const doc = querySnap.docs[0]
    res.status(200).json(toExternalHarvestOfferDto(doc.id, doc.data()))
  })
