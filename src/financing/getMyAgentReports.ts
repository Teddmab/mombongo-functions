import { db, admin, functions } from '../lib/admin'

function toIso(ts: unknown): string {
  if (!ts) return new Date().toISOString()
  if (typeof (ts as any)?.toDate === 'function') return (ts as any).toDate().toISOString()
  return String(ts)
}

export const getMyAgentReports = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const limit = Math.min((data?.limit ?? 20) as number, 100)

    const snap = await db
      .collection('agent_reports')
      .where('agentId', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get()

    const reports = snap.docs.map(d => {
      const r = d.data()
      return {
        id: d.id,
        farmerId:       r.farmerId ?? '',
        farmerName:     r.farmerName ?? '—',
        cropType:       r.cropType ?? r.growthStage ?? '—',
        region:         r.region ?? '—',
        visitDate:      toIso(r.visitDate),
        cropCondition:  r.cropCondition ?? 3,
        growthStage:    r.growthStage ?? '',
        problems:       r.problems ?? [],
        recommendations: r.recommendations ?? '',
        status:         r.status ?? 'en attente',
        createdAt:      toIso(r.createdAt),
        gpsLat:         r.gpsLat ?? null,
        gpsLng:         r.gpsLng ?? null,
        photoUrls:      r.photoUrls ?? [],
      }
    })

    return { reports }
  })
