import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * A minimal but behaviorally-real Firestore transaction simulator — not a
 * simple sequential mock. It reproduces the specific optimistic-
 * concurrency property this module's safety depends on: db.runTransaction
 * snapshots the version of every document a transaction reads, and only
 * commits if none of those versions changed before the callback finished;
 * otherwise it discards the attempt's writes and re-runs the callback
 * against fresh state, exactly like real Firestore. This lets the
 * "two concurrent identical submissions" test below exercise the actual
 * contention/retry mechanism the module's docstring claims, rather than
 * merely asserting sequential-call behavior.
 */
function makeFakeFirestore() {
  const store = new Map<string, { version: number; data: Record<string, unknown> | undefined }>()

  function versionOf(path: string): number {
    return store.get(path)?.version ?? 0
  }
  function dataOf(path: string): Record<string, unknown> | undefined {
    return store.get(path)?.data
  }

  function makeDocRef(path: string) {
    return {
      path,
      id: path.split('/').pop()!,
      get: async () => ({ exists: dataOf(path) !== undefined, data: () => dataOf(path) }),
    }
  }

  function collection(name: string) {
    return {
      doc: (id?: string) => makeDocRef(`${name}/${id ?? `auto-${Math.random().toString(36).slice(2)}`}`),
    }
  }

  async function runTransaction<T>(fn: (tx: any) => Promise<T>, maxAttempts = 5): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const readVersions = new Map<string, number>()
      const pendingWrites: [string, Record<string, unknown>][] = []

      const tx = {
        get: async (ref: { path: string }) => {
          readVersions.set(ref.path, versionOf(ref.path))
          return { exists: dataOf(ref.path) !== undefined, data: () => dataOf(ref.path) }
        },
        set: (ref: { path: string }, data: Record<string, unknown>) => {
          pendingWrites.push([ref.path, data])
        },
      }

      const result = await fn(tx)

      // Commit check: every document this attempt read must be unchanged
      // since it was read, or the whole attempt is discarded and retried
      // — this is the real Firestore contention rule, not a simplification.
      const conflict = [...readVersions.entries()].some(([path, v]) => versionOf(path) !== v)
      if (conflict) continue // discard pendingWrites, retry from scratch

      for (const [path, data] of pendingWrites) {
        store.set(path, { version: versionOf(path) + 1, data })
      }
      return result
    }
    throw new Error('transaction contention exceeded maxAttempts')
  }

  return { collection, runTransaction, _store: store }
}

const fakeDb = makeFakeFirestore()

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => fakeDb.collection(name),
    runTransaction: (fn: any) => fakeDb.runTransaction(fn),
  },
}))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: vi.fn(() => 'SERVER_TIMESTAMP') },
}))

import { submitIdempotentExternalHarvestOffer } from '../createExternalHarvestOfferIdempotency'

const LISTING_PATH = 'product_listings/listing-1'

function seedActiveListing() {
  fakeDb._store.set(LISTING_PATH, {
    version: 1,
    data: { status: 'active', sellerId: 'farmer-1', quantityKg: 1000 },
  })
}

const BASE_INPUT = {
  partnerId: 'arom',
  merchantId: 'merchant-arom',
  idempotencyKey: 'key-1',
  listingId: 'listing-1',
  offerQuantityKg: 50,
  offerPricePerKgCdf: 500,
}

describe('submitIdempotentExternalHarvestOffer', () => {
  beforeEach(() => {
    fakeDb._store.clear()
    seedActiveListing()
  })

  it('first valid request creates exactly one offer and one idempotency record', async () => {
    const result = await submitIdempotentExternalHarvestOffer(BASE_INPUT)
    expect(result.kind).toBe('created')
    if (result.kind !== 'created') throw new Error('unreachable')
    expect(result.offerId).toBeTruthy()

    const offerPaths = [...fakeDb._store.keys()].filter((p) => p.startsWith('harvest_offers/'))
    expect(offerPaths).toHaveLength(1)
    const idempotencyPaths = [...fakeDb._store.keys()].filter((p) => p.startsWith('partner_offer_idempotency/'))
    expect(idempotencyPaths).toHaveLength(1)
    expect(idempotencyPaths[0]).toBe('partner_offer_idempotency/arom::key-1')
  })

  it('sequential replay with the same key and same fingerprint returns the original offer, creates no second offer', async () => {
    const first = await submitIdempotentExternalHarvestOffer(BASE_INPUT)
    const second = await submitIdempotentExternalHarvestOffer(BASE_INPUT)

    expect(second.kind).toBe('replayed')
    if (first.kind === 'conflict' || second.kind === 'conflict') throw new Error('unreachable')
    expect(second.offerId).toBe(first.offerId)

    const offerPaths = [...fakeDb._store.keys()].filter((p) => p.startsWith('harvest_offers/'))
    expect(offerPaths).toHaveLength(1)
  })

  it('same key with a different fingerprint (different quantity) returns conflict, not a new offer', async () => {
    await submitIdempotentExternalHarvestOffer(BASE_INPUT)
    const conflicting = await submitIdempotentExternalHarvestOffer({ ...BASE_INPUT, offerQuantityKg: 99 })

    expect(conflicting.kind).toBe('conflict')
    const offerPaths = [...fakeDb._store.keys()].filter((p) => p.startsWith('harvest_offers/'))
    expect(offerPaths).toHaveLength(1) // still just the original
  })

  it('an invalid request (quantity exceeds listing) does not consume the key — a corrected retry with the same key succeeds', async () => {
    await expect(
      submitIdempotentExternalHarvestOffer({ ...BASE_INPUT, offerQuantityKg: 999999 }),
    ).rejects.toThrow('offerQuantityKg')

    // Nothing was written for the failed attempt.
    expect(fakeDb._store.has('partner_offer_idempotency/arom::key-1')).toBe(false)

    // Same key, corrected payload — must succeed as a fresh request, not a conflict.
    const retried = await submitIdempotentExternalHarvestOffer(BASE_INPUT)
    expect(retried.kind).toBe('created')
  })

  it('different partners using the identical Idempotency-Key value do not collide', async () => {
    const a = await submitIdempotentExternalHarvestOffer({ ...BASE_INPUT, partnerId: 'arom' })
    const b = await submitIdempotentExternalHarvestOffer({ ...BASE_INPUT, partnerId: 'other-partner' })
    if (a.kind === 'conflict' || b.kind === 'conflict') throw new Error('unreachable')
    expect(a.offerId).not.toBe(b.offerId)
    expect([...fakeDb._store.keys()].filter((p) => p.startsWith('harvest_offers/'))).toHaveLength(2)
  })

  it('two truly simultaneous identical submissions persist exactly one offer (real transaction contention, not sequential calls)', async () => {
    // Promise.all fires both requests before either has a chance to
    // complete — this exercises the fake Firestore's actual contention
    // detection (see makeFakeFirestore's runTransaction) rather than two
    // back-to-back awaited calls, which would trivially "work" even with
    // a naive read-then-write implementation.
    const [a, b] = await Promise.all([
      submitIdempotentExternalHarvestOffer(BASE_INPUT),
      submitIdempotentExternalHarvestOffer(BASE_INPUT),
    ])

    expect([a.kind, b.kind].sort()).toEqual(['created', 'replayed'])
    if (a.kind === 'conflict' || b.kind === 'conflict') throw new Error('unreachable')
    expect(a.offerId).toBe(b.offerId)

    const offerPaths = [...fakeDb._store.keys()].filter((p) => p.startsWith('harvest_offers/'))
    expect(offerPaths).toHaveLength(1)
  })

  it('externalReference is echoed back on both the original and a replayed response', async () => {
    const withRef = { ...BASE_INPUT, externalReference: 'arom-po-42' }
    const first = await submitIdempotentExternalHarvestOffer(withRef)
    const second = await submitIdempotentExternalHarvestOffer(withRef)
    if (first.kind === 'conflict' || second.kind === 'conflict') throw new Error('unreachable')
    expect(first.externalReference).toBe('arom-po-42')
    expect(second.externalReference).toBe('arom-po-42')
  })
})
