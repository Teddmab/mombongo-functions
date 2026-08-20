import { admin, functions } from '../lib/admin'
import { sendMorningPricePushCore, type MorningPushDiagnostics } from './sendMorningPricePush'

const db = admin.firestore()

export const adminTriggerMorningPricePush = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    if (!context.auth?.uid)
      throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const callerSnap = await db.collection('users').doc(context.auth.uid).get()
    if (callerSnap.data()?.role !== 'admin')
      throw new functions.https.HttpsError('permission-denied', 'Admin only')

    functions.logger.info(`adminTriggerMorningPricePush: triggered manually by ${context.auth.uid}`)

    const diag: MorningPushDiagnostics = await sendMorningPricePushCore()

    return { success: true, triggeredAt: new Date().toISOString(), diag }
  })
