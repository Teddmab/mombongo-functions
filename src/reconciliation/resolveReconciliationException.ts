import { admin, db, functions } from '../lib/admin'

/** Admin-only. Marks a flagged reconciliation exception as reviewed — records who and why, never silently clears it. */
export const resolveReconciliationException = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const adminUid = context.auth?.uid
    if (!adminUid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const callerSnap = await db.collection('users').doc(adminUid).get()
    if (callerSnap.data()?.role !== 'admin')
      throw new functions.https.HttpsError('permission-denied', 'Admin only')

    const { transactionId, note } = (data ?? {}) as { transactionId?: string; note?: string }
    if (!transactionId) throw new functions.https.HttpsError('invalid-argument', 'transactionId required')
    if (!note?.trim()) throw new functions.https.HttpsError('invalid-argument', 'note required')

    const txRef = db.collection('transactions').doc(transactionId)
    const txSnap = await txRef.get()
    if (!txSnap.exists) throw new functions.https.HttpsError('not-found', 'Transaction not found')
    if (txSnap.data()?.reconciliationStatus !== 'exception')
      throw new functions.https.HttpsError('failed-precondition', "Cette transaction n'a pas d'exception de rapprochement active")

    await txRef.update({
      reconciliationStatus: 'resolved_manually',
      reconciliationResolvedBy: adminUid,
      reconciliationResolvedAt: admin.firestore.FieldValue.serverTimestamp(),
      reconciliationResolutionNote: note.trim(),
    })

    functions.logger.info(`resolveReconciliationException: ${adminUid} resolved ${transactionId}`)
    return { success: true }
  })
