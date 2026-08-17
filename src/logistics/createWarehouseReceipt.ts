import { admin, db, functions } from '../lib/admin'

export const createWarehouseReceipt = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    if (!context.auth?.token.admin)
      throw new functions.https.HttpsError('permission-denied', 'Admin uniquement')

    const { farmerId, warehouseId, commodity, quantityKg, quality, daysStorage = 30 } = (data ?? {}) as {
      farmerId: string
      warehouseId: string
      commodity: string
      quantityKg: number
      quality: 'A' | 'B' | 'C'
      daysStorage?: number
    }

    if (!farmerId || !warehouseId || !commodity || !quantityKg || !quality)
      throw new functions.https.HttpsError('invalid-argument', 'Missing required fields')

    const [warehouseSnap, farmerSnap] = await Promise.all([
      db.collection('warehouses').doc(warehouseId).get(),
      db.collection('users').doc(farmerId).get(),
    ])

    if (!warehouseSnap.exists) throw new functions.https.HttpsError('not-found', 'Entrepôt introuvable')
    const w = warehouseSnap.data()!
    const farmerName = farmerSnap.data()?.fullName ?? 'Agriculteur'

    const countSnap = await db.collection('warehouse_receipts').count().get()
    const receiptNumber = `WR-${new Date().getFullYear()}-${String(countSnap.data().count + 1).padStart(5, '0')}`

    const now = new Date()
    const expiresAt = new Date(now.getTime() + daysStorage * 86400000)

    const ref = db.collection('warehouse_receipts').doc()
    const batch = db.batch()
    batch.set(ref, {
      farmerId,
      farmerName,
      warehouseId,
      warehouseName: w.name,
      commodity,
      quantityKg,
      quality,
      depositedAt: admin.firestore.Timestamp.fromDate(now),
      expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
      storageCostPerDayCdf: (w.ratePerKgPerDayCdf ?? 0) * quantityKg,
      receiptNumber,
      status: 'active',
      usedAsCollateral: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    })
    batch.update(warehouseSnap.ref, {
      currentUsedKg: admin.firestore.FieldValue.increment(quantityKg),
    })
    await batch.commit()

    return { receiptId: ref.id, receiptNumber }
  })
