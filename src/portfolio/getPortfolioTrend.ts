import { admin, functions } from '../lib/admin'

const db = admin.firestore()

type Period = '7d' | '30d' | '90d' | '1y'

const PERIOD_DAYS: Record<Period, number> = {
  '7d': 7, '30d': 30, '90d': 90, '1y': 365,
}

export const getPortfolioTrend = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { period = '30d' } = (data ?? {}) as { period?: Period }
    const days = PERIOD_DAYS[period] ?? 30

    const since = new Date()
    since.setDate(since.getDate() - days)
    const sinceTs = admin.firestore.Timestamp.fromDate(since)

    const [userSnap, txSnap] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('transactions')
        .where('userId', '==', uid)
        .where('createdAt', '>=', sinceTs)
        .orderBy('createdAt', 'asc')
        .limit(500)
        .get(),
    ])

    const currentBalance: number = (userSnap.data()?.walletUsd ?? 0) as number

    // Build daily balance by working backwards from current balance
    const txs = txSnap.docs.map(d => {
      const dd = d.data()
      return {
        type: (dd.type as string) ?? '',
        amountUsd: (dd.amountUsd as number) ?? 0,
        createdAt: (dd.createdAt as admin.firestore.Timestamp)?.toDate?.() ?? new Date(),
      }
    })

    // Accumulate net effect per day key
    const dayMap: Record<string, number> = {}
    for (const tx of txs) {
      const key = tx.createdAt.toISOString().slice(0, 10)
      const delta = ['deposit', 'repayment', 'revenue'].includes(tx.type)
        ? tx.amountUsd
        : ['withdrawal', 'investment', 'bourse_investment'].includes(tx.type)
        ? -tx.amountUsd
        : 0
      dayMap[key] = (dayMap[key] ?? 0) + delta
    }

    // Build chart points by replaying from current balance backwards
    const points: { date: string; balanceUsd: number }[] = []
    let running = currentBalance
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      if (i < days - 1) {
        // undo next day's transactions to go back
        running -= (dayMap[key] ?? 0)
      }
      points.unshift({ date: key, balanceUsd: Math.max(0, running) })
    }
    // Correct: rebuild forward
    const forwardPoints: { date: string; balanceUsd: number }[] = []
    let bal = currentBalance
    // Walk from today backward to get starting balance
    for (let i = 0; i < days; i++) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      bal -= (dayMap[key] ?? 0)
    }
    // Now walk forward
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      bal += (dayMap[key] ?? 0)
      forwardPoints.push({ date: key, balanceUsd: Math.max(0, bal) })
    }

    return { trend: forwardPoints }
  })
