import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const getContract = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { contractId } = (data ?? {}) as { contractId: string }
    if (!contractId) throw new functions.https.HttpsError('invalid-argument', 'contractId required')

    const snap = await db.collection('bourse_contracts').doc(contractId).get()
    if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Contrat introuvable')
    const contract = snap.data()!
    if (contract.buyerId !== uid && contract.sellerId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Non autorisé')
    }
    return { contract: { id: snap.id, ...contract } }
  })

export const getMyContracts = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const [asBuyer, asSeller] = await Promise.all([
      db.collection('bourse_contracts').where('buyerId', '==', uid).limit(30).get(),
      db.collection('bourse_contracts').where('sellerId', '==', uid).limit(30).get(),
    ])

    const map = new Map<string, Record<string, unknown>>()
    for (const d of [...asBuyer.docs, ...asSeller.docs]) {
      map.set(d.id, { id: d.id, ...d.data() })
    }
    return { contracts: Array.from(map.values()) }
  })
