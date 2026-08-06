import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const confirmShipment = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { contractId, shipmentNote } = (data ?? {}) as {
      contractId: string
      shipmentNote?: string
    }
    if (!contractId) throw new functions.https.HttpsError('invalid-argument', 'contractId required')

    const contractRef = db.collection('bourse_contracts').doc(contractId)
    const contractSnap = await contractRef.get()
    if (!contractSnap.exists) throw new functions.https.HttpsError('not-found', 'Contrat introuvable')

    const contract = contractSnap.data()!
    if (contract.sellerId !== uid) {
      throw new functions.https.HttpsError('permission-denied', "Seul le vendeur peut confirmer l'expédition")
    }
    if (contract.escrowStatus !== 'funded') {
      throw new functions.https.HttpsError('failed-precondition', 'Séquestre non financé')
    }

    const now = admin.firestore.FieldValue.serverTimestamp()
    await contractRef.update({
      status: 'shipped',
      shipmentNote: shipmentNote ?? '',
      shippedAt: now,
      updatedAt: now,
    })

    if (contract.matchId) {
      await db.collection('bourse_matches').doc(contract.matchId).update({
        status: 'shipped',
        updatedAt: now,
      })
    }

    return { success: true, status: 'shipped' }
  })
