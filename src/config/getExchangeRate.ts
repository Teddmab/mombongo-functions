import { admin, functions } from '../lib/admin'

const db = admin.firestore()

const DEFAULT_RATE = 2800

export const getExchangeRate = functions
  .region('europe-west1')
  .https.onCall(async (_data, _context) => {
    try {
      const snap = await db.collection('config').doc('exchangeRate').get()
      if (!snap.exists) {
        return { rate: DEFAULT_RATE, updatedAt: new Date().toISOString() }
      }
      const data = snap.data()!
      const ts = data.updatedAt
      return {
        rate: typeof data.rate === 'number' ? data.rate : DEFAULT_RATE,
        updatedAt: ts?.toDate ? ts.toDate().toISOString() : new Date().toISOString(),
      }
    } catch {
      return { rate: DEFAULT_RATE, updatedAt: new Date().toISOString() }
    }
  })
