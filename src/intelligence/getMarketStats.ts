import { admin, functions } from '../lib/admin'
const db = admin.firestore()

export const getMarketStats = functions
  .region('europe-west1')
  .https.onCall(async (data: any) => {
    const period: 'week' | 'month' = data?.period ?? 'month'
    const since = new Date()
    since.setDate(since.getDate() - (period === 'week' ? 7 : 30))

    const [contractsSnap, ordersSnap, listingsSnap] = await Promise.all([
      db.collection('bourse_contracts')
        .where('status', '==', 'fulfilled')
        .where('createdAt', '>=', since).get(),
      db.collection('buyer_orders')
        .where('createdAt', '>=', since).get(),
      db.collection('product_listings')
        .where('status', '==', 'active')
        .where('createdAt', '>=', since).get(),
    ])

    const volumeByCommodity: Record<string, { kg: number; valueCdf: number; count: number }> = {}
    contractsSnap.docs.forEach(d => {
      const { commodity, quantityKg, totalCdf } = d.data()
      if (!commodity) return
      if (!volumeByCommodity[commodity]) volumeByCommodity[commodity] = { kg: 0, valueCdf: 0, count: 0 }
      volumeByCommodity[commodity].kg += quantityKg ?? 0
      volumeByCommodity[commodity].valueCdf += totalCdf ?? 0
      volumeByCommodity[commodity].count++
    })

    const demandByMonth: Record<string, number> = {}
    ordersSnap.docs.forEach(d => {
      const neededBy = d.data().neededBy?.toDate?.()
      if (neededBy) {
        const month = (neededBy as Date).toISOString().slice(0, 7)
        demandByMonth[month] = (demandByMonth[month] ?? 0) + 1
      }
    })

    const totalContractValueCdf = contractsSnap.docs.reduce(
      (sum, d) => sum + (d.data().totalCdf ?? 0), 0
    )

    return {
      stats: {
        period,
        totalFulfilledContracts: contractsSnap.size,
        totalContractValueCdf,
        totalActiveListings: listingsSnap.size,
        totalOpenOrders: ordersSnap.size,
        volumeByCommodity,
        demandByMonth,
      }
    }
  })
