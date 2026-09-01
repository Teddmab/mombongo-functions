import { db, functions } from '../lib/admin'
import { reconcileRecentTransactions } from './reconcileTransactionsCore'

const WINDOW_DAYS = 7
const BATCH_LIMIT = 200

/** Scheduled — checks recent, not-yet-checked transactions for internal consistency against their provider record. See reconcileTransactionsCore.ts for exactly what this does and does not verify. */
export const reconcileTransactions = functions
  .region('europe-west1')
  .pubsub.schedule('0 */6 * * *')
  .timeZone('Africa/Kinshasa')
  .onRun(async () => {
    const { checked, exceptions } = await reconcileRecentTransactions(WINDOW_DAYS, BATCH_LIMIT)
    functions.logger.info(`reconcileTransactions: checked ${checked}, found ${exceptions} exception(s)`)
  })

/** Admin-triggered — same check, run on demand instead of waiting for the next scheduled pass. */
export const runReconciliationCheck = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const adminUid = context.auth?.uid
    if (!adminUid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const callerSnap = await db.collection('users').doc(adminUid).get()
    if (callerSnap.data()?.role !== 'admin')
      throw new functions.https.HttpsError('permission-denied', 'Admin only')

    return reconcileRecentTransactions(WINDOW_DAYS, BATCH_LIMIT)
  })
