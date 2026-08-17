import { db, functions } from '../lib/admin'

export const getMyWarehouseReceipts = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const snap = await db.collection('warehouse_receipts')
      .where('farmerId', '==', uid)
      .where('status', '==', 'active')
      .orderBy('depositedAt', 'desc')
      .get()

    const receipts = snap.docs.map(d => {
      const data = d.data()
      return {
        id: d.id,
        farmerId: data.farmerId,
        farmerName: data.farmerName,
        warehouseId: data.warehouseId,
        warehouseName: data.warehouseName,
        commodity: data.commodity,
        quantityKg: data.quantityKg,
        quality: data.quality,
        depositedAt: data.depositedAt?.toDate?.()?.toISOString() ?? null,
        expiresAt: data.expiresAt?.toDate?.()?.toISOString() ?? null,
        storageCostPerDayCdf: data.storageCostPerDayCdf,
        receiptNumber: data.receiptNumber,
        status: data.status,
        usedAsCollateral: data.usedAsCollateral ?? false,
        collateralApplicationId: data.collateralApplicationId ?? null,
      }
    })

    return { receipts }
  })
