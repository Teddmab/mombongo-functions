import { admin, functions } from '../lib/admin'

const db = admin.firestore()

function toIso(ts: unknown): string {
  if (!ts) return new Date().toISOString()
  if (ts instanceof admin.firestore.Timestamp) return ts.toDate().toISOString()
  if (typeof ts === 'string') return ts
  return new Date().toISOString()
}

export const getMyActivity = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { limit: lim = 20 } = (data ?? {}) as { limit?: number }
    const effectiveLimit = Math.min(lim, 50)

    const [txSnap, invSnap] = await Promise.all([
      db.collection('transactions')
        .where('userId', '==', uid)
        .orderBy('createdAt', 'desc')
        .limit(effectiveLimit)
        .get(),
      db.collection('investments')
        .where('investorId', '==', uid)
        .orderBy('investedAt', 'desc')
        .limit(10)
        .get(),
    ])

    const txItems = txSnap.docs.map(d => {
      const data = d.data()
      return {
        id: d.id,
        kind: 'transaction' as const,
        type: (data.type as string) ?? 'deposit',
        description: (data.description as string) ?? (data.productName as string) ?? '',
        amountUsd: (data.amountUsd as number) ?? 0,
        status: (data.status as string) ?? 'completed',
        createdAt: toIso(data.createdAt),
      }
    })

    const invItems = invSnap.docs.map(d => {
      const data = d.data()
      return {
        id: d.id,
        kind: 'investment' as const,
        type: 'investment' as const,
        description: (data.productName as string) ?? '',
        amountUsd: (data.amountUsd as number) ?? 0,
        status: (data.status as string) ?? 'active',
        createdAt: toIso(data.investedAt),
      }
    })

    const combined = [...txItems, ...invItems]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, effectiveLimit)

    return { activity: combined }
  })
