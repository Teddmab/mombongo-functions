import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const getMyFinancingApplications = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const snap = await db.collection('financing_applications')
      .where('farmerId', '==', uid)
      .orderBy('createdAt', 'desc')
      .get()

    const applications = snap.docs.map(d => {
      const data = d.data()
      return {
        id: d.id,
        farmerId: (data.farmerId as string) ?? uid,
        farmerName: (data.farmerName as string) ?? '',
        cropType: (data.cropType ?? data.commodity ?? '') as string,
        surfaceHa: (data.surfaceHa as number) ?? 0,
        purpose: (data.purpose as string) ?? 'autre',
        requestedAmountUsd: (data.requestedAmountUsd ?? data.requestedAmount ?? 0) as number,
        durationMonths: (data.durationMonths as number) ?? 0,
        province: (data.province as string) ?? '',
        description: (data.description as string) ?? '',
        status: (data.status as string) ?? 'pending',
        agentId: (data.agentId as string | null) ?? null,
        disbursedAmountUsd: (data.disbursedAmountUsd ?? data.disbursedAmount ?? 0) as number,
        createdAt: (data.createdAt?.toDate?.() ?? new Date()).toISOString(),
      }
    })

    return { applications }
  })
