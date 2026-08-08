import { admin, functions } from '../lib/admin'

const db = admin.firestore()

function toIso(ts: unknown): string {
  if (!ts) return new Date().toISOString()
  if (ts instanceof admin.firestore.Timestamp) return ts.toDate().toISOString()
  return new Date().toISOString()
}

export const getMyBoursePositions = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const snap = await db.collection('bourse_investments')
      .where('investorId', '==', uid)
      .orderBy('investedAt', 'desc')
      .limit(100)
      .get()

    const positions = snap.docs.map(d => {
      const data = d.data()
      return {
        id: d.id,
        opportunityId: (data.opportunityId as string) ?? '',
        opportunityTitle: (data.opportunityTitle as string) ?? '',
        commodity: (data.commodity as string) ?? '',
        amountCdf: (data.amountCdf as number) ?? 0,
        amountUsd: (data.amountUsd as number) ?? null,
        expectedReturnPct: (data.expectedReturnPct as number) ?? null,
        status: (data.status as string) ?? 'active',
        investedAt: toIso(data.investedAt),
      }
    })

    return { positions }
  })
