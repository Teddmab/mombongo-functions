import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const getPortfolioBreakdown = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const snap = await db.collection('investments')
      .where('investorId', '==', uid)
      .where('status', 'in', ['active', 'matured'])
      .limit(200)
      .get()

    const byCategory: Record<string, number> = {}
    let total = 0
    for (const d of snap.docs) {
      const data = d.data()
      const key: string = (data.productName as string) ?? (data.cropType as string) ?? 'Autre'
      const amt: number = (data.amountUsd as number) ?? 0
      byCategory[key] = (byCategory[key] ?? 0) + amt
      total += amt
    }

    const breakdown = Object.entries(byCategory)
      .map(([name, amountUsd]) => ({
        name,
        amountUsd,
        pct: total > 0 ? Math.round((amountUsd / total) * 100) : 0,
      }))
      .sort((a, b) => b.amountUsd - a.amountUsd)
      .slice(0, 6)

    return { breakdown, totalUsd: total }
  })
