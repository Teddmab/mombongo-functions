import { admin, functions } from '../lib/admin'
const db = admin.firestore()
const FieldValue = admin.firestore.FieldValue

export const checkPriceAlerts = functions
  .region('europe-west1')
  .pubsub.schedule('0 8 * * *')
  .timeZone('Africa/Kinshasa')
  .onRun(async () => {
    const alertsSnap = await db.collection('price_alerts')
      .where('status', '==', 'active')
      .get()

    for (const alertDoc of alertsSnap.docs) {
      const alert = alertDoc.data()

      const priceSnap = await db.collection('bourse_prices_by_province')
        .where('commodity', '==', alert.commodity)
        .where('province', '==', alert.province)
        .orderBy('recordedAt', 'desc')
        .limit(1)
        .get()

      if (priceSnap.empty) {
        await alertDoc.ref.update({ lastCheckedAt: FieldValue.serverTimestamp() })
        continue
      }

      const currentPrice: number = priceSnap.docs[0].data().priceCdfPerKg

      const triggered = alert.direction === 'above'
        ? currentPrice >= alert.targetPriceCdf
        : currentPrice <= alert.targetPriceCdf

      if (!triggered) {
        await alertDoc.ref.update({ lastCheckedAt: FieldValue.serverTimestamp() })
        continue
      }

      await alertDoc.ref.update({ status: 'triggered', triggeredAt: FieldValue.serverTimestamp() })

      const userSnap = await db.collection('users').doc(alert.userId).get()
      const tokens: string[] = userSnap.data()?.fcmTokens ?? []
      if (tokens.length === 0) continue

      const { getMessaging } = await import('firebase-admin/messaging')
      await getMessaging().sendEachForMulticast({
        tokens,
        notification: {
          title: `Alerte prix — ${alert.commodity}`,
          body: `${alert.commodity} à ${currentPrice.toLocaleString()} FC/kg à ${alert.province} — votre objectif de ${alert.targetPriceCdf.toLocaleString()} FC/kg est atteint !`,
        },
        data: { type: 'price_alert', commodity: alert.commodity, province: alert.province },
      })
    }
  })
