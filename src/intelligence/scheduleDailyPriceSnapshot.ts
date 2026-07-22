import { admin, functions } from '../lib/admin'
const db = admin.firestore()
const FieldValue = admin.firestore.FieldValue

export const scheduleDailyPriceSnapshot = functions
  .region('europe-west1')
  .pubsub.schedule('30 23 * * *')
  .timeZone('Africa/Kinshasa')
  .onRun(async () => {
    const snap = await db.collection('bourse_prices_by_province').get()
    const batch = db.batch()
    const today = new Date().toISOString().split('T')[0]

    snap.docs.forEach(d => {
      const ref = db.collection('price_history').doc()
      batch.set(ref, { ...d.data(), date: today, recordedAt: FieldValue.serverTimestamp() })
    })

    await batch.commit()
  })
