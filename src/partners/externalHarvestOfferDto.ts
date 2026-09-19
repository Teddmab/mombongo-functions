/** Normalizes a Firestore Timestamp, JS Date, or plain string into ISO 8601 — mirrors getExternalPublishedListings.ts's toIso, kept local to avoid a cross-file coupling for one helper. */
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
 * Explicit external contract for the reconciliation/read API
 * (getExternalHarvestOffer, getExternalHarvestOffers) — same discipline as
 * getExternalPublishedListings.ts's toPublishedListing: a curated shape,
 * never a raw Firestore doc spread, so internal fields (source,
 * merchantId — Mombongo's synthetic merchant uid, never meant for a
 * partner to see) never leak.
 */
export function toExternalHarvestOfferDto(id: string, data: FirebaseFirestore.DocumentData) {
  return {
    offerId: id,
    externalReference: (data.externalReference as string | null) ?? null,
    listingId: (data.listingId as string) ?? null,
    status: (data.status as string) ?? null,
    quantityKg: (data.offerQuantityKg as number) ?? 0,
    unitPriceCdf: (data.offerPricePerKgCdf as number) ?? 0,
    currency: 'CDF' as const,
    createdAt: toIso(data.createdAt),
    updatedAt: toIso(data.updatedAt),
    invoiceId: (data.invoiceId as string | null) ?? null,
  }
}
