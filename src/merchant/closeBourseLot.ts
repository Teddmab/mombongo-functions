import { db, functions } from '../lib/admin'

export const closeBourseLot = functions.region('europe-west1').https.onCall(async (data, context) => {
  const uid = context.auth?.uid
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

  const { lotId } = (data ?? {}) as { lotId: string }
  if (!lotId) throw new functions.https.HttpsError('invalid-argument', 'lotId required')

  const oppRef = db.collection('bourse_opportunities').doc(lotId)
  const opp = await oppRef.get()
  if (!opp.exists) throw new functions.https.HttpsError('not-found', 'Lot not found')
  if (opp.data()?.createdBy !== uid) throw new functions.https.HttpsError('permission-denied', 'Not your lot')

  await oppRef.update({ status: 'closed' })
  return { success: true }
})
