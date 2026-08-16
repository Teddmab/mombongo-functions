import * as admin from 'firebase-admin'
import { db, functions } from '../lib/admin'
import { sendPush } from '../notifications/sendPush'

export const reserveBourseLot = functions.region('europe-west1').https.onCall(async (data, context) => {
  const uid = context.auth?.uid
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

  const { opportunityId, parts, paymentMethod } = (data ?? {}) as {
    opportunityId: string; parts: number; paymentMethod?: string
  }
  if (!opportunityId || !parts || Number(parts) < 1) {
    throw new functions.https.HttpsError('invalid-argument', 'opportunityId and parts (>= 1) required')
  }

  const oppRef = db.collection('bourse_opportunities').doc(opportunityId)

  const reservationId = await db.runTransaction(async txn => {
    const opp = await txn.get(oppRef)
    if (!opp.exists) throw new functions.https.HttpsError('not-found', 'Lot not found')

    const oppData = opp.data()!
    if (oppData.status !== 'open') throw new functions.https.HttpsError('failed-precondition', 'Lot is no longer available')
    if (oppData.spotsLeft !== null && oppData.spotsLeft < Number(parts)) {
      throw new functions.https.HttpsError('failed-precondition', `Only ${oppData.spotsLeft} spot(s) remaining`)
    }

    const resRef = db.collection('bourse_investments').doc()
    txn.set(resRef, {
      investorId:       uid,
      investorType:     'merchant',
      opportunityId,
      opportunityTitle: oppData.title ?? '',
      parts:            Number(parts),
      paymentMethod:    paymentMethod ?? 'mobile-money',
      status:           'reserved',
      createdAt:        admin.firestore.FieldValue.serverTimestamp(),
    })

    if (oppData.spotsLeft !== null) {
      const newLeft = oppData.spotsLeft - Number(parts)
      txn.update(oppRef, {
        spotsLeft: newLeft,
        ...(newLeft <= 0 ? { status: 'full' } : {}),
      })
    }

    return resRef.id
  })

  // Notify lot creator
  const opp = await oppRef.get()
  const creatorId = opp.data()?.createdBy as string | undefined
  if (creatorId && creatorId !== uid) {
    await sendPush(
      creatorId,
      '🎉 Votre lot a été réservé',
      `${parts} part(s) réservée(s) sur "${opp.data()?.title}"`,
      { opportunityId, type: 'lot_reserved' }
    ).catch(() => undefined)
  }

  return { reservationId }
})
