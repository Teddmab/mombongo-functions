import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const confirmShipment = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { contractId, trackingInfo } = data as {
      contractId: string
      trackingInfo?: string
    }

    const contractRef = db.collection('bourse_contracts').doc(contractId)

    await db.runTransaction(async tx => {
      const snap = await tx.get(contractRef)
      if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Contrat introuvable')

      const c = snap.data()!
      if (c.sellerId !== uid)
        throw new functions.https.HttpsError('permission-denied', "Seul le vendeur peut confirmer l'expedition")
      if (c.status !== 'funded')
        throw new functions.https.HttpsError('failed-precondition', 'Séquestre non financé')

      const now = admin.firestore.FieldValue.serverTimestamp()
      tx.update(contractRef, {
        status: 'shipped',
        shippedAt: now,
        trackingInfo: trackingInfo ?? '',
        updatedAt: now,
      })
    })

    return { ok: true }
  })
