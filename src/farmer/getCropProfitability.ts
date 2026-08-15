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

interface CropBucket {
  commodity: string
  revenueUsd: number
  totalCostCdf: number
  harvestCount: number
}

export const getCropProfitability = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const season = (data as { season?: string })?.season || currentSeason()
    const { start, end } = seasonToDateRange(season)

    const [boursSnap, transformSnap, harvestSnap, rateSnap] = await Promise.all([
      db.collection('bourse_contracts')
        .where('sellerId', '==', uid)
        .where('status', '==', 'completed')
        .where('completedAt', '>=', admin.firestore.Timestamp.fromDate(start))
        .where('completedAt', '<=', admin.firestore.Timestamp.fromDate(end))
        .get(),
      db.collection('product_transformations')
        .where('farmerId', '==', uid)
        .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(start))
        .where('createdAt', '<=', admin.firestore.Timestamp.fromDate(end))
        .get(),
      db.collection('harvest_records')
        .where('farmerId', '==', uid)
        .where('harvestDate', '>=', start.toISOString().slice(0, 10))
        .where('harvestDate', '<=', end.toISOString().slice(0, 10))
        .get(),
      db.collection('config').doc('exchange_rate').get(),
    ])

    const exchangeRate: number = rateSnap.exists
      ? (rateSnap.data()?.usdToCdf ?? 2800)
      : 2800

    const buckets: Record<string, CropBucket> = {}

    const ensureBucket = (commodity: string) => {
      if (!buckets[commodity]) {
        buckets[commodity] = { commodity, revenueUsd: 0, totalCostCdf: 0, harvestCount: 0 }
      }
    }

    for (const doc of boursSnap.docs) {
      const d = doc.data()
      const c = d.commodity as string
      if (!c) continue
      ensureBucket(c)
      buckets[c].revenueUsd += d.sellerAmountUsd ?? 0
    }

    for (const doc of transformSnap.docs) {
      const d = doc.data()
      const c = d.commodity as string
      if (!c) continue
      ensureBucket(c)
      buckets[c].totalCostCdf += d.totalCostCdf ?? 0
    }

    for (const doc of harvestSnap.docs) {
      const d = doc.data()
      const c = d.commodity as string
      if (!c) continue
      ensureBucket(c)
      buckets[c].harvestCount += 1
    }

    const rows = Object.values(buckets).map(b => {
      const totalCostUsd = b.totalCostCdf / exchangeRate
      const netProfitUsd = Math.round((b.revenueUsd - totalCostUsd) * 100) / 100
      const marginPct = b.revenueUsd > 0
        ? Math.round((netProfitUsd / b.revenueUsd) * 100)
        : 0
      return {
        commodity: b.commodity,
        revenueUsd: Math.round(b.revenueUsd * 100) / 100,
        totalCostCdf: b.totalCostCdf,
        netProfitUsd,
        marginPct,
        harvestCount: b.harvestCount,
      }
    })

    rows.sort((a, b) => b.marginPct - a.marginPct)

    return { rows }
  })
