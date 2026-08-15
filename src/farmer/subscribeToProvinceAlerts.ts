import { admin, functions } from '../lib/admin'

const db = admin.firestore()
const FieldValue = admin.firestore.FieldValue

export const subscribeToProvinceAlerts = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { province, commodities = [] } = (data ?? {}) as { province: string; commodities: string[] }
    if (!province) throw new functions.https.HttpsError('invalid-argument', 'province required')

    await db.collection('users').doc(uid).update({
      advisorySubscriptions: {
        province,
        commodities,
        subscribedAt: FieldValue.serverTimestamp(),
      },
    })

    return { success: true }
  })
