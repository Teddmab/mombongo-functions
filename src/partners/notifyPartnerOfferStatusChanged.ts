import { FieldValue } from 'firebase-admin/firestore'
import { db, functions } from '../lib/admin'
import { sendSignedPartnerWebhook } from './sendSignedPartnerWebhook'
import { computeEventId } from '../lib/eventId'

export const OFFER_STATUS_CHANGED_SCHEMA_VERSION = 1

interface OfferStatusChangedPayload {
  eventId: string
  schemaVersion: number
  occurredAt: string
  partnerId: string
  offerId: string
  externalReference: string | null
  listingId: string
  status: 'accepted' | 'declined'
  quantityKg: number
  unitPriceCdf: number
  currency: 'CDF'
}

/**
 * Authoritative accepted/declined signal for a partner-sourced offer.
 * Called AFTER selectHarvestOffer's transaction has committed — never
 * from inside it. A Firestore transaction can retry its callback on
 * contention (see createExternalHarvestOfferIdempotency.ts's docstring
 * for the mechanics), and a network call inside a transaction callback
 * would otherwise risk firing once per retry for a state change that
 * only actually happened once.
 *
 * eventId is deterministic (offerId + status), not random — a retry of
 * this same call (automatic backoff, or a later manual admin retry via
 * adminRetryPartnerNotification) reuses the identical eventId, which is
 * what lets AROM dedupe deliveries without Mombongo tracking delivery
 * attempts as separate events.
 *
 * In-app offers (partnerId: null) have no webhookUrl to call and are
 * silently skipped — this is not an error, just nothing to notify.
 */
export async function notifyPartnerOfferStatusChanged(
  offerId: string,
  status: 'accepted' | 'declined',
): Promise<void> {
  const offerSnap = await db.collection('harvest_offers').doc(offerId).get()
  if (!offerSnap.exists) {
    functions.logger.error(`notifyPartnerOfferStatusChanged: offer ${offerId} not found`)
    return
  }
  const offer = offerSnap.data()!
  if (!offer.partnerId) return // in-app offer — nothing to notify

  const partnerSnap = await db.collection('partners').doc(offer.partnerId).get()
  const webhookUrl = partnerSnap.data()?.webhookUrl as string | undefined
  const outboundSecret = partnerSnap.data()?.outboundHmacSecret as string | undefined
  if (!webhookUrl || !outboundSecret) {
    functions.logger.error(`No webhookUrl/outboundHmacSecret configured for partner ${offer.partnerId}`)
    return
  }

  const payload: OfferStatusChangedPayload = {
    eventId: computeEventId('offer_status_changed', offerId, status),
    schemaVersion: OFFER_STATUS_CHANGED_SCHEMA_VERSION,
    occurredAt: new Date().toISOString(),
    partnerId: offer.partnerId,
    offerId,
    externalReference: (offer.externalReference as string | null) ?? null,
    listingId: offer.listingId,
    status,
    quantityKg: offer.offerQuantityKg,
    unitPriceCdf: offer.offerPricePerKgCdf,
    currency: 'CDF',
  }

  await sendSignedPartnerWebhook({
    webhookUrl,
    outboundSecret,
    payload,
    kind: 'offer_status_changed',
    partnerId: offer.partnerId,
    invoiceId: offerId, // see sendSignedPartnerWebhook.ts's doc comment — this slot holds "the record's id", not literally an invoice id here
    onSuccess: async () => {
      await offerSnap.ref.update({
        [`${status}NotifiedAt`]: FieldValue.serverTimestamp(),
      })
    },
  })
}
