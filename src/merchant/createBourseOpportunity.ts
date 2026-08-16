import * as admin from 'firebase-admin'
import { db, functions } from '../lib/admin'

export const createBourseOpportunity = functions.region('europe-west1').https.onCall(async (data, context) => {
  const uid = context.auth?.uid
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

  const { title, lotType, origin, destination, volumeDesc, priceDesc, duration, spotsAvailable } = (data ?? {}) as {
    title: string; lotType: string; origin: string; destination?: string
    volumeDesc: string; priceDesc: string; duration?: string; spotsAvailable?: number
  }

  if (!title || !lotType || !origin || !volumeDesc || !priceDesc) {
    throw new functions.https.HttpsError('invalid-argument', 'title, lotType, origin, volumeDesc, priceDesc required')
  }
  if (!['transport', 'stockage', 'transformation'].includes(lotType)) {
    throw new functions.https.HttpsError('invalid-argument', 'lotType must be transport, stockage, or transformation')
  }

  const userDoc = await db.collection('users').doc(uid).get()
  const creatorName = (userDoc.data()?.displayName as string) ?? ''

  const spots = spotsAvailable ? Number(spotsAvailable) : null

  const ref = await db.collection('bourse_opportunities').add({
    createdBy:    uid,
    creatorName,
    title,
    type:         lotType,
    origin,
    destination:  destination ?? null,
    volume:       volumeDesc,
    price:        priceDesc,
    duration:     duration ?? null,
    spotsTotal:   spots,
    spotsLeft:    spots,
    commission:   0,
    status:       'open',
    createdAt:    admin.firestore.FieldValue.serverTimestamp(),
  })

  return { opportunityId: ref.id }
})
