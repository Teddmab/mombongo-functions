import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const getBoursePricesByProvince = functions
  .region('europe-west1')
  .https.onCall(async (data, _context) => {
    const { commodity } = (data ?? {}) as { commodity?: string }

    let q: FirebaseFirestore.Query = db.collection('bourse_prices_by_province')
      .orderBy('recordedAt', 'desc')
      .limit(200)

    if (commodity) {
      q = db.collection('bourse_prices_by_province')
        .where('commodity', '==', commodity)
        .orderBy('recordedAt', 'desc')
        .limit(50)
    }

    const snap = await q.get()

    // Return only the latest price per commodity+province pair
    const latest = new Map<string, Record<string, unknown>>()
    snap.docs.forEach(d => {
      const row = d.data()
      const key = `${row.commodity}|${row.province}`
      if (!latest.has(key)) latest.set(key, { id: d.id, ...row })
    })

    return { prices: [...latest.values()] }
  })
