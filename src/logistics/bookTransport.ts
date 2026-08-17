import { admin, db, functions } from '../lib/admin'

export const bookTransport = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { contractId, transportPartnerId, estimatedPickupDate, notes } = (data ?? {}) as {
      contractId: string
      transportPartnerId: string
      estimatedPickupDate?: string
      notes?: string
    }

    if (!contractId || !transportPartnerId)
      throw new functions.https.HttpsError('invalid-argument', 'contractId and transportPartnerId required')

    const contractSnap = await db.collection('bourse_contracts').doc(contractId).get()
    if (!contractSnap.exists) throw new functions.https.HttpsError('not-found', 'Contrat introuvable')
    const c = contractSnap.data()!

    if (c.sellerId !== uid)
      throw new functions.https.HttpsError('permission-denied', 'Vendeur uniquement')
    if (c.status !== 'funded')
      throw new functions.https.HttpsError('failed-precondition', 'Séquestre non financé')

    const partnerSnap = await db.collection('transport_partners').doc(transportPartnerId).get()
    if (!partnerSnap.exists) throw new functions.https.HttpsError('not-found', 'Partenaire introuvable')
    const p = partnerSnap.data()!

    const now = admin.firestore.FieldValue.serverTimestamp()
    const bookingRef = db.collection('shipment_bookings').doc()

    const batch = db.batch()
    batch.set(bookingRef, {
      contractId,
      sellerId: c.sellerId,
      buyerId: c.buyerId,
      transportPartnerId,
      partnerName: p.name,
      partnerPhone: p.phone,
      estimatedPickupDate: estimatedPickupDate ?? null,
      notes: notes ?? '',
      status: 'booked',
      createdAt: now,
    })
    batch.update(db.collection('bourse_contracts').doc(contractId), {
      transportPartnerId,
      transportPartnerName: p.name,
      transportPartnerPhone: p.phone,
      bookingId: bookingRef.id,
      updatedAt: now,
    })
    await batch.commit()

    return { bookingId: bookingRef.id }
  })
