import { admin, db, functions } from '../lib/admin'

export const updateShipmentStatus = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { contractId, shipmentStatus, notes } = (data ?? {}) as {
      contractId: string
      shipmentStatus: 'in_transit' | 'arrived'
      notes?: string
    }

    const VALID = ['in_transit', 'arrived'] as const
    if (!VALID.includes(shipmentStatus))
      throw new functions.https.HttpsError('invalid-argument', 'Statut invalide')

    const contractRef = db.collection('bourse_contracts').doc(contractId)

    await db.runTransaction(async tx => {
      const snap = await tx.get(contractRef)
      if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Contrat introuvable')
      const c = snap.data()!
      if (c.sellerId !== uid)
        throw new functions.https.HttpsError('permission-denied', 'Vendeur uniquement')
      if (c.status !== 'shipped')
        throw new functions.https.HttpsError('failed-precondition', 'Expédition non confirmée')

      const now = admin.firestore.FieldValue.serverTimestamp()
      tx.update(contractRef, {
        shipmentStatus,
        [`shipmentStatusHistory.${shipmentStatus}`]: now,
        ...(notes !== undefined ? { notes } : {}),
        updatedAt: now,
      })
    })

    // FCM notification to buyer
    const contractSnap = await contractRef.get()
    const c = contractSnap.data()!
    const buyerSnap = await db.collection('users').doc(c.buyerId as string).get()
    const tokens: string[] = buyerSnap.data()?.fcmTokens ?? []
    if (tokens.length > 0) {
      const { getMessaging } = await import('firebase-admin/messaging')
      const statusLabel = shipmentStatus === 'in_transit' ? 'en route' : 'arrivée à destination'
      await getMessaging().sendEachForMulticast({
        tokens,
        notification: {
          title: `Livraison ${statusLabel}`,
          body: `Votre commande de ${c.commodity} est ${statusLabel}.`,
        },
        data: { type: 'shipment_status', contractId, shipmentStatus },
      })
    }

    return { ok: true }
  })
