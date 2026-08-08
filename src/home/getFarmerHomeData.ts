import { admin, functions } from '../lib/admin'

const db = admin.firestore()

function toIso(ts: any): string {
  if (!ts) return new Date().toISOString()
  return (ts.toDate ? ts.toDate() : new Date(ts)).toISOString()
}

export const getFarmerHomeData = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    // 1. All active cultures across all farmer's exploitations
    const explSnap = await db.collection('exploitations')
      .where('farmerId', '==', uid)
      .get()

    const cultures: any[] = []
    await Promise.all(
      explSnap.docs.map(async (expl) => {
        const cultSnap = await db.collection('exploitations').doc(expl.id)
          .collection('cultures')
          .where('status', '==', 'active')
          .get()
        cultSnap.docs.forEach(d => cultures.push({ id: d.id, exploitationId: expl.id, ...d.data() }))
      })
    )

    // 2. Assigned agent
    const farmerSnap = await db.collection('users').doc(uid).get()
    const farmerData = farmerSnap.data() ?? {}
    let agent: { name: string; phone: string; photo: string | null } | null = null
    if (farmerData.agentId) {
      const agentSnap = await db.collection('users').doc(farmerData.agentId as string).get()
      if (agentSnap.exists) {
        const a = agentSnap.data()!
        agent = {
          name: (a.displayName ?? a.fullName ?? '') as string,
          phone: (a.phone ?? '') as string,
          photo: (a.photoURL ?? a.avatarUrl ?? null) as string | null,
        }
      }
    }

    // 3. Active financing application (approved or disbursed, most recent)
    const finSnap = await db.collection('financing_applications')
      .where('farmerId', '==', uid)
      .where('status', 'in', ['approved', 'disbursed'])
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get()
    const financing = finSnap.empty ? null : (() => {
      const d = finSnap.docs[0].data()
      return {
        id: finSnap.docs[0].id,
        status: d.status as string,
        requestedAmount: (d.requestedAmount ?? 0) as number,
        disbursedAmount: (d.disbursedAmount ?? 0) as number,
        commodity: (d.commodity ?? '') as string,
        createdAt: toIso(d.createdAt),
      }
    })()

    // 4. Unread notifications (limit 5)
    const alertsSnap = await db.collection('notifications')
      .where('userId', '==', uid)
      .where('read', '==', false)
      .orderBy('createdAt', 'desc')
      .limit(5)
      .get()
    const alerts = alertsSnap.docs.map(d => {
      const n = d.data()
      return {
        id: d.id,
        kind: (n.type ?? 'agent') as string,
        title: (n.title ?? '') as string,
        body: (n.body ?? '') as string,
        time: toIso(n.createdAt),
        urgent: (n.urgent ?? false) as boolean,
      }
    })

    return { cultures, agent, financing, alerts }
  })
