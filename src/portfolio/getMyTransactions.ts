import { admin, functions } from '../lib/admin'

const db = admin.firestore()

function toIso(ts: unknown): string {
  if (!ts) return new Date().toISOString()
  if (ts instanceof admin.firestore.Timestamp) return ts.toDate().toISOString()
  if (typeof ts === 'string') return ts
  return new Date().toISOString()
}

export const getMyTransactions = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { type, cursor, limit: lim = 20 } = (data ?? {}) as {
      type?: string
      cursor?: string
      limit?: number
    }

    const effectiveLimit = Math.min(lim, 50)

    let q = db.collection('transactions')
      .where('userId', '==', uid)
      .orderBy('createdAt', 'desc') as FirebaseFirestore.Query

    if (type) q = q.where('type', '==', type)

    if (cursor) {
      const cursorDoc = await db.collection('transactions').doc(cursor).get()
      if (cursorDoc.exists) q = q.startAfter(cursorDoc)
    }

    q = q.limit(effectiveLimit + 1)
    const snap = await q.get()

    const hasMore = snap.docs.length > effectiveLimit
    const docs = hasMore ? snap.docs.slice(0, effectiveLimit) : snap.docs

    const transactions = docs.map(d => {
      const dd = d.data()
      return {
        id: d.id,
        type: (dd.type as string) ?? 'deposit',
        description: (dd.description as string) ?? (dd.productName as string) ?? '',
        amountUsd: (dd.amountUsd as number) ?? 0,
        status: (dd.status as string) ?? 'completed',
        reference: (dd.reference as string) ?? null,
        provider: (dd.provider as string) ?? null,
        investmentId: (dd.investmentId as string) ?? null,
        productId: (dd.productId as string) ?? null,
        createdAt: toIso(dd.createdAt),
      }
    })

    return {
      transactions,
      hasMore,
      nextCursor: hasMore ? docs[docs.length - 1].id : null,
    }
  })
