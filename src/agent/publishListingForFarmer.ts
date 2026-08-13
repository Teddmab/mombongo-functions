import { db, admin, functions } from '../lib/admin'

export const publishListingForFarmer = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const agentUid = context.auth?.uid
    if (!agentUid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { farmerId, commodity, quantityDesc, pricePerUnitCdf, province, harvestDate } = data as {
      farmerId: string
      commodity: string
      quantityDesc?: string
      pricePerUnitCdf?: number
      province?: string
      harvestDate?: string
    }

    if (!farmerId || !commodity)
      throw new functions.https.HttpsError('invalid-argument', 'farmerId and commodity are required')

    const farmerSnap = await db.collection('users').doc(farmerId).get()
    if (!farmerSnap.exists) throw new functions.https.HttpsError('not-found', 'Agriculteur introuvable')
    const farmer = farmerSnap.data()!

    if (farmer.agentId !== agentUid)
      throw new functions.https.HttpsError('permission-denied', "Cet agriculteur n'est pas dans votre portefeuille")

    const now = admin.firestore.FieldValue.serverTimestamp()
    const ref = db.collection('product_listings').doc()
    await ref.set({
      sellerId: farmerId,
      sellerName: farmer.displayName ?? farmer.fullName ?? 'Agriculteur',
      publishedByAgentId: agentUid,
      commodity,
      quantityDesc: quantityDesc ?? '',
      pricePerUnitCdf: pricePerUnitCdf ?? 0,
      province: province ?? farmer.province ?? farmer.region ?? '',
      availableFrom: harvestDate ?? null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })

    return { listingId: ref.id }
  })
