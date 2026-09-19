import { db, functions } from '../lib/admin'
import { verifyPartnerSignature } from './verifyPartnerSignature'
import { submitIdempotentExternalHarvestOffer } from './createExternalHarvestOfferIdempotency'

const MAX_IDEMPOTENCY_KEY_LENGTH = 200

/**
 * Contract v2 (2026-09) — requires Idempotency-Key. v1 (no header) had no
 * duplicate-submission protection at all: two identical requests created
 * two independent offers, and a request that timed out after Mombongo
 * committed could never be reconciled by the caller. There is exactly one
 * caller of this endpoint today (AROM), so this is shipped as a hard
 * requirement rather than an optional upgrade path — a caller without the
 * header now gets a clear 400 instead of the old silent double-submission
 * risk.
 *
 * Response shape also changes: v1 returned {status: "accepted", offerId},
 * which collided "your HTTP request was accepted" with "the farmer
 * accepted your offer" in the same word. v2 uses submissionStatus, which
 * only ever means "we received and processed this HTTP request" — never
 * a business-acceptance signal. Business acceptance is exclusively
 * communicated via the offer_status_changed webhook.
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

    const idempotencyKey = req.header('idempotency-key')
    if (!idempotencyKey || !idempotencyKey.trim()) {
      res.status(400).send('Idempotency-Key header required')
      return
    }
    if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH || idempotencyKey.includes('/')) {
      res.status(400).send(`Idempotency-Key must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters and must not contain "/"`)
      return
    }

    const partnerSnap = await db.collection('partners').doc(partnerId as string).get()
    const merchantUid = partnerSnap.data()?.merchantUid as string | undefined
    if (!merchantUid) {
      res.status(500).send('Partner not fully provisioned')
      return
    }

    const { listingId, offerQuantityKg, offerPricePerKgCdf, message, externalReference } = (req.body ?? {}) as {
      listingId?: string
      offerQuantityKg?: number
      offerPricePerKgCdf?: number
      message?: string
      externalReference?: string
    }
    if (!listingId || !offerQuantityKg || !offerPricePerKgCdf) {
      res.status(400).send('listingId, offerQuantityKg and offerPricePerKgCdf required')
      return
    }

    try {
      const result = await submitIdempotentExternalHarvestOffer({
        partnerId: partnerId as string,
        merchantId: merchantUid,
        idempotencyKey: idempotencyKey.trim(),
        listingId,
        offerQuantityKg,
        offerPricePerKgCdf,
        message,
        externalReference,
      })

      if (result.kind === 'conflict') {
        res.status(409).send('Idempotency-Key was already used for a different request')
        return
      }

      res.status(200).json({
        submissionStatus: 'submitted',
        offerId: result.offerId,
        externalReference: result.externalReference,
        replayed: result.kind === 'replayed',
      })
    } catch (err) {
      res.status(400).send(err instanceof Error ? err.message : 'Invalid offer')
    }
  })
