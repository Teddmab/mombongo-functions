import { db, admin, functions } from '../lib/admin'

export const submitAgentReport = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const {
      farmerId,
      visitDate,
      cropCondition,
      growthStage,
      surfaceHa,
      problems,
      disbursedUsd,
      additionalNeedUsd,
      recommendations,
      nextVisitDate,
      photoUrls,
    } = data as {
      farmerId: string
      visitDate?: string
      cropCondition?: number
      growthStage?: string
      surfaceHa?: number
      problems?: string[]
      disbursedUsd?: number
      additionalNeedUsd?: number
      recommendations: string
      nextVisitDate?: string
      photoUrls?: string[]
    }

    if (!farmerId || !recommendations)
      throw new functions.https.HttpsError('invalid-argument', 'farmerId and recommendations required')

    const farmerSnap = await db.collection('farmers').doc(farmerId).get()
    if (!farmerSnap.exists)
      throw new functions.https.HttpsError('not-found', 'Farmer not found')

    const now = admin.firestore.FieldValue.serverTimestamp()
    await db.collection('agent_reports').add({
      agentId: uid,
      farmerId,
      visitDate: visitDate ? new Date(visitDate) : now,
      cropCondition: cropCondition ?? null,
      growthStage: growthStage ?? null,
      surfaceHa: surfaceHa ?? null,
      problems: problems ?? [],
      disbursedUsd: disbursedUsd ?? 0,
      additionalNeedUsd: additionalNeedUsd ?? 0,
      recommendations,
      nextVisitDate: nextVisitDate ? new Date(nextVisitDate) : null,
      photoUrls: photoUrls ?? [],
      createdAt: now,
    })

    return { success: true }
  })
