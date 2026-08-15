import { admin, functions } from '../lib/admin'

const db = admin.firestore()
const FieldValue = admin.firestore.FieldValue

export const createListingFromTransformation = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { transformationId, pricePerKgCdf, province, territory, availableUntil, description } = (data ?? {}) as {
      transformationId: string
      pricePerKgCdf: number
      province: string
      territory: string
      availableUntil: string
      description?: string
    }

    if (!transformationId) throw new functions.https.HttpsError('invalid-argument', 'transformationId requis')
    if (!pricePerKgCdf || pricePerKgCdf <= 0) throw new functions.https.HttpsError('invalid-argument', 'Prix invalide')
    if (!province) throw new functions.https.HttpsError('invalid-argument', 'Province requise')

    const txSnap = await db.collection('product_transformations').doc(transformationId).get()
    if (!txSnap.exists) throw new functions.https.HttpsError('not-found', 'Transformation introuvable')

    const tx = txSnap.data()!
    if (tx.farmerId !== uid) throw new functions.https.HttpsError('permission-denied', 'Non autorisé')
    if (tx.status !== 'recorded') throw new functions.https.HttpsError('failed-precondition', 'Cette transformation est déjà publiée')

    const userSnap = await db.collection('users').doc(uid).get()
    const sellerName = userSnap.data()?.displayName ?? 'Agriculteur'

    const listingRef = db.collection('product_listings').doc()
    const now = FieldValue.serverTimestamp()
    const batch = db.batch()

    batch.set(listingRef, {
      sellerId: uid,
      sellerName,
      sellerRole: 'farmer',
      commodity: tx.transformedProduct,
      quantityKg: tx.transformedQuantityKg,
      quality: tx.rawQuality,
      province,
      territory: territory ?? '',
      pricePerKgCdf,
      availableFrom: new Date().toISOString(),
      availableUntil: new Date(availableUntil).toISOString(),
      description: description ?? `${tx.rawQuantityKg} kg de ${tx.rawCommodity} transformés. Rendement: ${tx.yieldPct}%.`,
      photoUrls: [],
      status: 'active',
      sourceTransformationId: transformationId,
      createdAt: now,
      updatedAt: now,
    })

    batch.update(txSnap.ref, {
      status: 'listed',
      listingId: listingRef.id,
      updatedAt: now,
    })

    await batch.commit()
    return { listingId: listingRef.id }
  })
