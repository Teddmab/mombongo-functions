import { admin, functions } from '../lib/admin'
const db = admin.firestore()

export interface DidYouKnowFact {
  id: string
  fr: string
  en: string
  ln: string
}

export const getDidYouKnowFacts = functions
  .region('europe-west1')
  .https.onCall(async (_data, _context) => {
    const snap = await db.collection('did_you_know')
      .where('active', '==', true)
      .orderBy('order', 'asc')
      .get()

    const facts: DidYouKnowFact[] = snap.docs.map(d => ({
      id: d.id,
      fr: d.data().fr ?? '',
      en: d.data().en ?? '',
      ln: d.data().ln ?? '',
    }))

    return { facts }
  })
