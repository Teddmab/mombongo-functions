import * as admin from 'firebase-admin'
import { db, functions } from '../lib/admin'
import { sendPush } from '../notifications/sendPush'

export const createPrePurchase = functions.region('europe-west1').https.onCall(async (data, context) => {
  const uid = context.auth?.uid
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

  const { farmerId, cropType, amountUsd, expectedHarvestDate, notes } = (data ?? {}) as {
    farmerId: string; cropType: string; amountUsd: number
    expectedHarvestDate?: string; notes?: string
  }

  if (!farmerId || !cropType || !amountUsd) {
    throw new functions.https.HttpsError('invalid-argument', 'farmerId, cropType, amountUsd required')
  }
  if (Number(amountUsd) < 10) {
    throw new functions.https.HttpsError('invalid-argument', 'Minimum pre-purchase amount is $10')
  }

  const [merchantDoc, farmerDoc] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection('users').doc(farmerId).get(),
  ])

  if (!farmerDoc.exists) throw new functions.https.HttpsError('not-found', 'Farmer not found')

  const merchantName = (merchantDoc.data()?.displayName as string) ?? ''
  const farmerName   = (farmerDoc.data()?.displayName as string) ?? ''

  const ref = await db.collection('pre_purchases').add({
    merchantId:           uid,
    merchantName,
    farmerId,
    farmerName,
    cropType,
    amountUsd:            Number(amountUsd),
    expectedHarvestDate:  expectedHarvestDate ?? null,
    notes:                notes ?? null,
    status:               'pending',
    createdAt:            admin.firestore.FieldValue.serverTimestamp(),
  })

  await sendPush(
    farmerId,
    '💰 Offre de pré-achat reçue',
    `${merchantName} propose $${amountUsd} pour votre ${cropType}`,
    { prePurchaseId: ref.id, type: 'pre_purchase_offer' }
  ).catch(() => undefined)

  return { prePurchaseId: ref.id }
})
