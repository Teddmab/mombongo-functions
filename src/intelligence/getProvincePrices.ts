import { admin, functions } from '../lib/admin'
const db = admin.firestore()

export const getProvincePrices = functions
  .region('europe-west1')
  .https.onCall(async (data: any) => {
    const { commodity, province } = data as { commodity: string; province: string }
    if (!commodity || !province) {
      throw new functions.https.HttpsError('invalid-argument', 'commodity and province required')
    }

    const [pricesSnap, rateSnap, listingsSnap] = await Promise.all([
      db.collection('province_prices')
        .where('commodity', '==', commodity)
        .where('province', '==', province)
        .orderBy('updatedAt', 'desc')
        .limit(5)
        .get(),
      db.collection('config').doc('exchange_rate').get(),
      db.collection('product_listings')
        .where('commodity', '==', commodity)
        .where('province', '==', province)
        .where('status', '==', 'active')
        .limit(50)
        .get(),
    ])

    const usdToCdf = (rateSnap.data()?.usdToCdf as number) ?? 2800

    if (pricesSnap.empty) {
      return { found: false, activeBuyers: listingsSnap.size }
    }

    const prices = pricesSnap.docs.map(d => (d.data().priceUsd as number) * usdToCdf)
    const minPriceCdf = Math.round(Math.min(...prices))
    const maxPriceCdf = Math.round(Math.max(...prices))

    return {
      found: true,
      commodity,
      province,
      minPriceCdf,
      maxPriceCdf,
      activeBuyers: listingsSnap.size,
    }
  })
