import { admin, functions } from '../lib/admin'

const db = admin.firestore()
const FieldValue = admin.firestore.FieldValue

export const recordActualHarvest = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const {
      cultureId,
      actualYieldKg,
      qualityGrade,
      harvestDate,
      warehouseLocation,
      notes,
    } = (data ?? {}) as {
      cultureId: string
      actualYieldKg: number
      qualityGrade: 'A' | 'B' | 'C' | 'D'
      harvestDate: string
      warehouseLocation?: string
      notes?: string
    }

    if (!cultureId) throw new functions.https.HttpsError('invalid-argument', 'cultureId required')
    if (!actualYieldKg || actualYieldKg <= 0) throw new functions.https.HttpsError('invalid-argument', 'actualYieldKg must be > 0')
    if (!qualityGrade || !['A', 'B', 'C', 'D'].includes(qualityGrade)) throw new functions.https.HttpsError('invalid-argument', 'qualityGrade must be A/B/C/D')

    const cultureSnap = await db.collection('cultures').doc(cultureId).get()
    if (!cultureSnap.exists) throw new functions.https.HttpsError('not-found', 'Culture not found')
    const culture = cultureSnap.data()!
    if (culture.farmerId !== uid) throw new functions.https.HttpsError('not-found', 'Culture not found')

    const expectedYieldKg: number = culture.productionAttenduKg ?? culture.expectedYieldKg ?? 0
    const yieldVsExpectedPct = expectedYieldKg > 0
      ? Math.round((actualYieldKg / expectedYieldKg) * 100)
      : 0

    const harvestTs = new Date(harvestDate)
    const recordRef = db.collection('harvest_records').doc()

    await db.runTransaction(async (tx) => {
      tx.set(recordRef, {
        farmerId: uid,
        cultureId,
        exploitationId: culture.exploitationId ?? null,
        commodity: culture.commodity,
        expectedYieldKg,
        actualYieldKg,
        yieldVsExpectedPct,
        qualityGrade,
        harvestDate: admin.firestore.Timestamp.fromDate(harvestTs),
        warehouseLocation: warehouseLocation ?? null,
        notes: notes ?? null,
        createdAt: FieldValue.serverTimestamp(),
      })
      tx.update(cultureSnap.ref, {
        actualYieldKg,
        yieldVsExpectedPct,
        status: 'harvested',
        harvestDate: admin.firestore.Timestamp.fromDate(harvestTs),
        updatedAt: FieldValue.serverTimestamp(),
      })
    })

    return { recordId: recordRef.id, yieldVsExpectedPct }
  })
