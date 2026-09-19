import { FieldValue } from 'firebase-admin/firestore'
import { db } from '../lib/admin'
import { createHarvestOfferCore } from '../marketplace/createHarvestOfferCore'
import { computeOfferFingerprint, normalizeOfferMessage } from './offerFingerprint'

/**
 * Idempotent offer submission for the partner API. The identity that
 * matters is (partnerId, Idempotency-Key) — the same key from two
 * different partners must never collide, so the idempotency record's
 * document ID is the composite `${partnerId}::${idempotencyKey}`, not the
 * key alone.
 *
 * Concurrency proof (why this is safe without a read-then-write race):
 * both the idempotency-record read AND the offer-creation write happen
 * inside ONE db.runTransaction() call, on the SAME idempotency document
 * path. Firestore's transaction commit protocol detects contention on any
 * document a transaction read from if that document changed before
 * commit, and automatically re-runs the whole callback (up to 5 times,
 * Admin SDK default) rather than committing a stale write. For two
 * simultaneous identical requests: both transactions read the
 * not-yet-existing idempotency doc, both proceed to build an offer +
 * write the idempotency doc — but only ONE can actually commit, because
 * both write to the identical idempotency document path. The loser's
 * commit is rejected (the doc changed since its read), so the SDK
 * transparently retries the loser's callback from the top; on retry it
 * sees the idempotency doc now exists (created by the winner), compares
 * fingerprints, and returns `replayed: true` with the WINNER's offerId —
 * its own would-be second offer write was part of the aborted attempt
 * and was never durably committed. Net effect: exactly one harvest_offers
 * document is ever persisted for the pair, with no explicit locking and
 * no "in_flight" status needed. This is the same check-then-set-in-one-
 * transaction pattern already used by adminCreateAssistedInvoice.ts's own
 * clientRequestId idempotency, not a new technique introduced here.
 *
 * An invalid request (bad listing/quantity/price) throws from inside the
 * transaction before either write happens — the whole transaction is
 * discarded, so the idempotency key is never consumed by a failed
 * attempt, and a corrected retry with the same key succeeds normally.
 */
export type SubmitIdempotentOfferResult =
  | { kind: 'created'; offerId: string; externalReference: string | null }
  | { kind: 'replayed'; offerId: string; externalReference: string | null }
  | { kind: 'conflict' }

export interface SubmitIdempotentOfferInput {
  partnerId: string
  merchantId: string
  idempotencyKey: string
  listingId: string
  offerQuantityKg: number
  offerPricePerKgCdf: number
  message?: string | null
  externalReference?: string | null
}

export async function submitIdempotentExternalHarvestOffer(
  input: SubmitIdempotentOfferInput,
): Promise<SubmitIdempotentOfferResult> {
  const normalizedMessage = normalizeOfferMessage(input.message)
  const externalReference = normalizeOfferMessage(input.externalReference)
  const fingerprint = computeOfferFingerprint({
    listingId: input.listingId,
    offerQuantityKg: input.offerQuantityKg,
    offerPricePerKgCdf: input.offerPricePerKgCdf,
    message: normalizedMessage,
    externalReference,
  })

  const idempotencyRef = db
    .collection('partner_offer_idempotency')
    .doc(`${input.partnerId}::${input.idempotencyKey}`)

  return db.runTransaction(async (tx): Promise<SubmitIdempotentOfferResult> => {
    const existing = await tx.get(idempotencyRef)
    if (existing.exists) {
      const record = existing.data()!
      if (record.fingerprint !== fingerprint) {
        return { kind: 'conflict' }
      }
      return {
        kind: 'replayed',
        offerId: record.offerId as string,
        externalReference: (record.externalReference as string | null) ?? null,
      }
    }

    // Throws on validation failure -> transaction aborts, nothing
    // written, key stays free for a corrected retry.
    const { offerId } = await createHarvestOfferCore(
      {
        listingId: input.listingId,
        merchantId: input.merchantId,
        source: 'api',
        partnerId: input.partnerId,
        offerQuantityKg: input.offerQuantityKg,
        offerPricePerKgCdf: input.offerPricePerKgCdf,
        message: normalizedMessage,
        externalReference,
      },
      tx,
    )

    // No secret or raw HMAC value is ever written here — partnerId is an
    // identifier, not a credential, and the fingerprint is a hash of
    // request content, not of anything security-sensitive.
    tx.set(idempotencyRef, {
      partnerId: input.partnerId,
      idempotencyKey: input.idempotencyKey,
      fingerprint,
      offerId,
      externalReference,
      createdAt: FieldValue.serverTimestamp(),
    })

    return { kind: 'created', offerId, externalReference }
  })
}
