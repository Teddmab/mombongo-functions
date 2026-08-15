import { admin, functions } from '../lib/admin'

const db = admin.firestore()

interface FarmerPriceAlert {
  alertId: string
  farmerId: string
  commodity: string
  province: string
  thresholdUsd: number
  direction: 'above' | 'below'
  active: boolean
  lastTriggeredAt?: string | null
  createdAt: string
}

export const getFarmerPriceAlerts = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const snap = await db.collection('farmer_price_alerts')
      .where('farmerId', '==', uid)
      .where('active', '==', true)
      .orderBy('createdAt', 'desc')
      .get()

    const alerts: FarmerPriceAlert[] = snap.docs.map(doc => {
      const d = doc.data()
      return {
        alertId: doc.id,
        farmerId: d.farmerId,
        commodity: d.commodity,
        province: d.province,
        thresholdUsd: d.thresholdUsd,
        direction: d.direction,
        active: d.active,
        lastTriggeredAt: d.lastTriggeredAt?.toDate().toISOString() ?? null,
        createdAt: d.createdAt?.toDate().toISOString() ?? new Date().toISOString(),
      }
    })

    return { alerts }
  })
