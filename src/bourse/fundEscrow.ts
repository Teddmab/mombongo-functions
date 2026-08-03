import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const fundEscrow = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { contractId, method } = (data ?? {}) as {
      contractId: string
      method: 'wallet' | 'mobile_money'
      phone?: string
      operatorId?: string
    }

    if (!contractId) throw new functions.https.HttpsError('invalid-argument', 'contractId required')
    if (method !== 'wallet') {
      throw new functions.https.HttpsError(
        'unimplemented',
        'Mobile money escrow — sprint suivant',
      )
    }

    const contractRef = db.collection('bourse_contracts').doc(contractId)
    const contractSnap = await contractRef.get()
    if (!contractSnap.exists) throw new functions.https.HttpsError('not-found', 'Contrat introuvable')

    const contract = contractSnap.data()!
    if (contract.buyerId !== uid) {
      throw new functions.https.HttpsError(
        'permission-denied',
        "Seul l'acheteur peut financer le séquestre",
      )
    }
    if (contract.status !== 'active') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Contrat non signé par les deux parties',
      )
    }
    if (contract.escrowStatus === 'funded') {
      return { success: true, escrowStatus: 'funded', escrowId: contract.escrowId }
    }

    const amountCdf = contract.totalCdf as number
    const now = admin.firestore.FieldValue.serverTimestamp()

    const result = await db.runTransaction(async (tx) => {
      const userRef = db.collection('users').doc(uid)
      const [userSnap, freshContract] = await Promise.all([tx.get(userRef), tx.get(contractRef)])
      const walletCdf: number = userSnap.data()?.walletCdf ?? 0
      if (walletCdf < amountCdf) {
        throw new functions.https.HttpsError('failed-precondition', 'Solde FC insuffisant')
      }
      if (freshContract.data()?.escrowStatus === 'funded') {
        return {
          success: true,
          escrowStatus: 'funded' as const,
          escrowId: freshContract.data()?.escrowId as string,
        }
      }

      const escrowRef = db.collection('escrow_accounts').doc()
      tx.set(escrowRef, {
        contractId,
        matchId: contract.matchId,
        buyerId: uid,
        sellerId: contract.sellerId,
        amountCdf,
        depositedAt: now,
        status: 'funded',
        method: 'wallet',
        createdAt: now,
      })
      tx.update(userRef, { walletCdf: admin.firestore.FieldValue.increment(-amountCdf) })
      tx.update(contractRef, {
        escrowId: escrowRef.id,
        escrowStatus: 'funded',
        updatedAt: now,
      })
      return { success: true, escrowStatus: 'funded' as const, escrowId: escrowRef.id }
    })

    return result
  })
