import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export interface VisitPlanItem {
  farmerId: string
  farmerName: string
  province: string
  reasonCode: 'credit_urgent' | 'scheduled' | 'agro_alert' | 'overdue'
  reasonLabel: string
  urgencyLevel: 'high' | 'medium' | 'low'
  lastVisitDate: string
}

const FIVE_DAYS_MS  = 5  * 24 * 60 * 60 * 1000
const ONE_DAY_MS    = 1  * 24 * 60 * 60 * 1000
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000

export const getAgentVisitPlan = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const now = Date.now()

    // Fetch all farmers assigned to this agent
    const farmerSnap = await db.collection('farmers').where('agentId', '==', uid).get()
    if (farmerSnap.empty) return { farmers: [], generatedAt: admin.firestore.Timestamp.now() }

    const farmerIds = farmerSnap.docs.map(d => d.id)

    // Pre-fetch financing applications in under_review for this agent's farmers (batched)
    // Firestore `in` supports max 30 items; chunk if needed
    const chunks: string[][] = []
    for (let i = 0; i < farmerIds.length; i += 30) chunks.push(farmerIds.slice(i, i + 30))

    const urgentAppMap = new Map<string, boolean>() // farmerId → hasUrgentApp
    for (const chunk of chunks) {
      const appSnap = await db
        .collection('financing_applications')
        .where('farmerId', 'in', chunk)
        .where('status', '==', 'under_review')
        .get()
      for (const doc of appSnap.docs) {
        const updatedAt = (doc.data().updatedAt as admin.firestore.Timestamp | undefined)?.toMillis() ?? now
        if (now - updatedAt > FIVE_DAYS_MS) {
          urgentAppMap.set(doc.data().farmerId as string, true)
        }
      }
    }

    // Pre-fetch unacknowledged agro alerts (best-effort — collection may not exist yet)
    const alertFarmerSet = new Set<string>()
    try {
      for (const chunk of chunks) {
        const alertSnap = await db
          .collection('agro_alerts')
          .where('farmerId', 'in', chunk)
          .where('acknowledged', '==', false)
          .get()
        const cutoff = now - ONE_DAY_MS
        for (const doc of alertSnap.docs) {
          const createdAt = (doc.data().createdAt as admin.firestore.Timestamp | undefined)?.toMillis() ?? now
          if (createdAt < cutoff) alertFarmerSet.add(doc.data().farmerId as string)
        }
      }
    } catch {
      // agro_alerts collection doesn't exist yet — skip silently
    }

    const result: VisitPlanItem[] = []

    for (const farmerDoc of farmerSnap.docs) {
      if (result.length >= 3) break

      const d = farmerDoc.data()
      const farmerId = farmerDoc.id
      const farmerName = (d.name || d.fullName || 'Agriculteur') as string
      const province   = (d.province || d.region || '') as string
      const lastVisitTs = (d.lastVisitDate as admin.firestore.Timestamp | undefined)?.toMillis() ?? 0
      const lastVisitDate = lastVisitTs ? new Date(lastVisitTs).toISOString().split('T')[0] : ''
      const nextVisitTs = (d.nextVisitDate as admin.firestore.Timestamp | undefined)?.toMillis() ?? null

      // a) credit_urgent
      if (urgentAppMap.has(farmerId)) {
        result.push({ farmerId, farmerName, province, reasonCode: 'credit_urgent', reasonLabel: 'Crédit en attente d\'action', urgencyLevel: 'high', lastVisitDate })
        continue
      }

      // b) scheduled — nextVisitDate within ±1 day
      if (nextVisitTs !== null && Math.abs(nextVisitTs - now) <= ONE_DAY_MS) {
        result.push({ farmerId, farmerName, province, reasonCode: 'scheduled', reasonLabel: 'Visite planifiée aujourd\'hui', urgencyLevel: 'medium', lastVisitDate })
        continue
      }

      // c) agro_alert
      if (alertFarmerSet.has(farmerId)) {
        result.push({ farmerId, farmerName, province, reasonCode: 'agro_alert', reasonLabel: 'Alerte agronomique', urgencyLevel: 'medium', lastVisitDate })
        continue
      }

      // d) overdue — lastVisitDate > 14 days ago, no visit scheduled
      if (lastVisitTs > 0 && (now - lastVisitTs) > FOURTEEN_DAYS_MS && nextVisitTs === null) {
        result.push({ farmerId, farmerName, province, reasonCode: 'overdue', reasonLabel: 'Visite en retard', urgencyLevel: 'low', lastVisitDate })
      }
    }

    return {
      farmers: result,
      generatedAt: admin.firestore.Timestamp.now(),
    }
  })
