import { admin, functions } from '../lib/admin'

const db = admin.firestore()
const FieldValue = admin.firestore.FieldValue

export const recordProductTransformation = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const {
      rawCommodity,
      rawQuantityKg,
      rawQuality,
      transformationType,
      transformedProduct,
      transformedQuantityKg,
      processingCostCdf = 0,
      laborCostCdf = 0,
      transportCostCdf = 0,
      packagingCostCdf = 0,
      packagingUnit,
      unitCount,
      transformedAt,
      processorName,
      processorLocation,
      exploitationId,
      cultureId,
      notes,
    } = (data ?? {}) as {
      rawCommodity: string
      rawQuantityKg: number
      rawQuality: 'A' | 'B' | 'C'
      transformationType: string
      transformedProduct: string
      transformedQuantityKg: number
      processingCostCdf?: number
      laborCostCdf?: number
      transportCostCdf?: number
      packagingCostCdf?: number
      packagingUnit: string
      unitCount?: number
      transformedAt: string
      processorName?: string
      processorLocation?: string
      exploitationId?: string
      cultureId?: string
      notes?: string
    }

    if (!rawCommodity) throw new functions.https.HttpsError('invalid-argument', 'Produit source requis')
    if (!rawQuantityKg || rawQuantityKg <= 0) throw new functions.https.HttpsError('invalid-argument', 'Quantité source invalide')
    if (!transformedQuantityKg || transformedQuantityKg <= 0) throw new functions.https.HttpsError('invalid-argument', 'Quantité produit invalide')
    if (transformedQuantityKg > rawQuantityKg) throw new functions.https.HttpsError('invalid-argument', 'Le produit transformé ne peut dépasser la matière source')
    if (!transformationType) throw new functions.https.HttpsError('invalid-argument', 'Type de transformation requis')
    if (!transformedProduct) throw new functions.https.HttpsError('invalid-argument', 'Nom du produit obtenu requis')

    const totalCostCdf = (processingCostCdf ?? 0) + (laborCostCdf ?? 0) + (transportCostCdf ?? 0) + (packagingCostCdf ?? 0)
    const yieldPct = Math.round((transformedQuantityKg / rawQuantityKg) * 100)
    const costPerKgCdf = transformedQuantityKg > 0 ? Math.round(totalCostCdf / transformedQuantityKg) : 0

    const ref = db.collection('product_transformations').doc()
    await ref.set({
      farmerId: uid,
      exploitationId: exploitationId ?? null,
      cultureId: cultureId ?? null,
      rawCommodity,
      rawQuantityKg,
      rawQuality: rawQuality ?? 'B',
      transformationType,
      transformedProduct,
      transformedQuantityKg,
      yieldPct,
      processingCostCdf: processingCostCdf ?? 0,
      laborCostCdf: laborCostCdf ?? 0,
      transportCostCdf: transportCostCdf ?? 0,
      packagingCostCdf: packagingCostCdf ?? 0,
      totalCostCdf,
      costPerKgCdf,
      packagingUnit: packagingUnit ?? 'kg vrac',
      unitCount: unitCount ?? 1,
      transformedAt,
      processorName: processorName ?? null,
      processorLocation: processorLocation ?? null,
      status: 'recorded',
      listingId: null,
      notes: notes ?? '',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })

    return { transformationId: ref.id, yieldPct, totalCostCdf, costPerKgCdf }
  })
