import { admin, functions } from '../lib/admin'

const db = admin.firestore()

function seasonToDateRange(season: string): { start: Date; end: Date } {
  const year = parseInt(season.slice(0, 4), 10)
  const half = season.slice(4)
  if (half === 'A') {
    return { start: new Date(`${year}-01-01`), end: new Date(`${year}-06-30T23:59:59`) }
  }
  return { start: new Date(`${year}-07-01`), end: new Date(`${year}-12-31T23:59:59`) }
}

function currentSeason(): string {
  const now = new Date()
  const year = now.getFullYear()
  const half = now.getMonth() < 6 ? 'A' : 'B'
  return `${year}${half}`
}

export const getFarmPnlSummary = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const season = (data as { season?: string })?.season || currentSeason()
    const { start, end } = seasonToDateRange(season)

    const [boursSnap, inputsSnap, transformSnap, rateSnap] = await Promise.all([
      db.collection('bourse_contracts')
        .where('sellerId', '==', uid)
        .where('status', '==', 'completed')
        .where('completedAt', '>=', admin.firestore.Timestamp.fromDate(start))
        .where('completedAt', '<=', admin.firestore.Timestamp.fromDate(end))
        .get(),
      db.collection('farm_inputs')
        .where('farmerId', '==', uid)
        .where('purchasedAt', '>=', admin.firestore.Timestamp.fromDate(start))
        .where('purchasedAt', '<=', admin.firestore.Timestamp.fromDate(end))
        .get(),
      db.collection('product_transformations')
        .where('farmerId', '==', uid)
        .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(start))
        .where('createdAt', '<=', admin.firestore.Timestamp.fromDate(end))
        .get(),
      db.collection('config').doc('exchange_rate').get(),
    ])

    const revenueUsd = boursSnap.docs.reduce(
      (sum, d) => sum + (d.data().sellerAmountUsd ?? 0), 0
    )
    const inputCostCdf = inputsSnap.docs.reduce(
      (sum, d) => sum + (d.data().costCdf ?? 0), 0
    )
    const transformCostCdf = transformSnap.docs.reduce(
      (sum, d) => sum + (d.data().totalCostCdf ?? 0), 0
    )

    const exchangeRate: number = rateSnap.exists
      ? (rateSnap.data()?.usdToCdf ?? 2800)
      : 2800

    const totalCostCdf = inputCostCdf + transformCostCdf
    const totalCostUsd = Math.round((totalCostCdf / exchangeRate) * 100) / 100
    const netProfitUsd = Math.round((revenueUsd - totalCostUsd) * 100) / 100
    const marginPct = revenueUsd > 0
      ? Math.round((netProfitUsd / revenueUsd) * 100)
      : 0

    return {
      season,
      revenueUsd,
      totalCostCdf,
      totalCostUsd,
      netProfitUsd,
      marginPct,
      exchangeRate,
    }
  })
