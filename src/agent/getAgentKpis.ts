import { db, functions } from '../lib/admin'

export const getAgentKpis = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const [farmersSnap, pendingSnap] = await Promise.all([
      db.collection('users').where('agentId', '==', uid).where('role', '==', 'farmer').get(),
      db.collection('agent_reports').where('agentId', '==', uid).where('status', '==', 'en attente').get(),
    ])

    const farmers = farmersSnap.docs.map(d => d.data())
    const totalAreaHa = farmers.reduce((sum: number, f: any) => sum + (Number(f.surfaceHa) || 0), 0)
    const farmersOnTrack = farmers.filter((f: any) => f.reportStatus === 'on_track' || f.cropStatus === 'ok').length

    return {
      totalFarmers: farmersSnap.size,
      farmersOnTrack,
      totalAreaHa: Math.round(totalAreaHa * 10) / 10,
      pendingReports: pendingSnap.size,
    }
  })
