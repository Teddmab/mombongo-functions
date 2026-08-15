import { admin, functions } from '../lib/admin'

const db = admin.firestore()

type Severity = 'info' | 'warning' | 'critical'
const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 }

function tsToIso(val: unknown): string | null {
  if (!val) return null
  if (val instanceof admin.firestore.Timestamp) return val.toDate().toISOString()
  return null
}

export const getAgroAdvisory = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    if (!context.auth?.uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { province, commodities = [] } = (data ?? {}) as { province: string; commodities: string[] }
    if (!province) throw new functions.https.HttpsError('invalid-argument', 'province required')

    const now = admin.firestore.Timestamp.now()

    // Two queries: province-specific + national ("all")
    const [provSnap, allSnap] = await Promise.all([
      db.collection('agro_advisories')
        .where('province', '==', province)
        .where('effectiveTo', '>=', now)
        .get(),
      db.collection('agro_advisories')
        .where('province', '==', 'all')
        .where('effectiveTo', '>=', now)
        .get(),
    ])

    type AdvisoryRow = Record<string, unknown> & {
      advisoryId: string
      effectiveFrom: string | null
      effectiveTo: string | null
      createdAt: string | null
    }
    const docs: AdvisoryRow[] = [...provSnap.docs, ...allSnap.docs].map(d => {
      const doc = d.data() as Record<string, unknown>
      return {
        ...doc,
        advisoryId:    d.id,
        effectiveFrom: tsToIso(doc.effectiveFrom),
        effectiveTo:   tsToIso(doc.effectiveTo),
        createdAt:     tsToIso(doc.createdAt),
      } as AdvisoryRow
    })

    // Filter: effectiveFrom <= now, commodity match
    const filtered = docs.filter(doc => {
      const from = doc.effectiveFrom ? new Date(doc.effectiveFrom as string).getTime() : 0
      if (from > Date.now()) return false
      const commodity = doc.commodity as string | null | undefined
      if (commodity && commodities.length > 0 && !commodities.includes(commodity)) return false
      return true
    })

    // Sort: critical first, then by effectiveFrom desc
    filtered.sort((a, b) => {
      const sa = SEVERITY_ORDER[(a.severity as Severity) ?? 'info']
      const sb = SEVERITY_ORDER[(b.severity as Severity) ?? 'info']
      if (sa !== sb) return sa - sb
      return new Date(b.effectiveFrom as string || 0).getTime() - new Date(a.effectiveFrom as string || 0).getTime()
    })

    return { advisories: filtered.slice(0, 5) }
  })
