import { admin, db, functions } from '../lib/admin'

/**
 * Minimal support-ticket log — a real record instead of a dead
 * "Ouvrir un dossier de support" button. Deliberately no
 * assignment/status workflow/external notification: just createdBy,
 * the transaction it's about, and a description, listable in the admin
 * console. No support-ticket system existed anywhere before this.
 */
export const createSupportTicket = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const adminUid = context.auth?.uid
    if (!adminUid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const callerSnap = await db.collection('users').doc(adminUid).get()
    if (callerSnap.data()?.role !== 'admin')
      throw new functions.https.HttpsError('permission-denied', 'Admin only')

    const { transactionId, description } = (data ?? {}) as { transactionId?: string; description?: string }
    if (!transactionId) throw new functions.https.HttpsError('invalid-argument', 'transactionId required')
    if (!description?.trim()) throw new functions.https.HttpsError('invalid-argument', 'description required')

    const txSnap = await db.collection('transactions').doc(transactionId).get()
    if (!txSnap.exists) throw new functions.https.HttpsError('not-found', 'Transaction not found')

    const ref = await db.collection('support_tickets').add({
      transactionId,
      description: description.trim(),
      createdBy: adminUid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    functions.logger.info(`createSupportTicket: ${adminUid} opened ${ref.id} for transaction ${transactionId}`)
    return { ticketId: ref.id }
  })
