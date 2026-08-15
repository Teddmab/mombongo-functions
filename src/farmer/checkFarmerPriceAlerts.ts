import { admin, functions } from '../lib/admin'
import { sendPush } from '../notifications/sendPush'

const db = admin.firestore()
const FieldValue = admin.firestore.FieldValue

export const checkFarmerPriceAlerts = functions
  .region('europe-west1')
  .pubsub.schedule('0 8 * * *')
  .timeZone('Africa/Kinshasa')
  .onRun(async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)

    // Get province prices updated in the last 24h
    const pricesSnap = await db.collection('province_prices')
      .where('updatedAt', '>=', admin.firestore.Timestamp.fromDate(since))
      .get()

    for (const priceDoc of pricesSnap.docs) {
      const price = priceDoc.data()
      const priceUsd: number = price.priceUsd ?? 0
      if (!priceUsd || !price.commodity || !price.province) continue

      // Find matching active farmer alerts for this commodity + province
      const alertsSnap = await db.collection('farmer_price_alerts')
        .where('commodity', '==', price.commodity)
        .where('province', '==', price.province)
        .where('active', '==', true)
        .get()

      for (const alertDoc of alertsSnap.docs) {
        const alert = alertDoc.data()
        const triggered =
          (alert.direction === 'above' && priceUsd >= alert.thresholdUsd) ||
          (alert.direction === 'below' && priceUsd <= alert.thresholdUsd)

        if (!triggered) continue

        const dirLabel = alert.direction === 'above' ? 'dépasse' : 'descend sous'
        await sendPush(
          alert.farmerId,
          `📈 Alerte prix ${alert.commodity}`,
          `Prix actuel: $${priceUsd.toFixed(2)}/kg — votre seuil de $${alert.thresholdUsd} ${dirLabel} à ${alert.province}`,
          { type: 'farmer_price_alert', commodity: alert.commodity, province: alert.province }
        )

        await alertDoc.ref.update({ lastTriggeredAt: FieldValue.serverTimestamp() })
      }
    }
  })
