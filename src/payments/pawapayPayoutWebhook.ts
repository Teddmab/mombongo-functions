import { admin, db, functions } from '../lib/admin'
import { extractPawapayFee } from './pawapayFee'
import { verifyPawapayCallbackSignature } from './verifyPawapayCallbackSignature'

export const pawapayPayoutWebhook = functions
  .region('europe-west1')
  .https.onRequest(async (req, res) => {
    const valid = await verifyPawapayCallbackSignature({
      method: req.method,
      authority: req.headers.host ?? '',
      path: req.path,
      headers: req.headers as Record<string, string | string[] | undefined>,
      rawBody: (req as unknown as { rawBody?: Buffer }).rawBody,
    })
    if (!valid) {
      res.status(401).send('Invalid signature')
      return
    }

    const { payoutId, status } = req.body as { payoutId: string; status: string }
    if (!payoutId) { res.status(400).send('Missing payoutId'); return }

    const feeUsd = extractPawapayFee(req.body)

    const withdrawRef = db.collection('withdrawals').doc(payoutId)
    const withdrawSnap = await withdrawRef.get()

    // Guards both terminal states — a retry of an already-'failed' payout
    // webhook must not re-run the wallet refund below (found during the
    // RFC 9421 migration's idempotency review: the original guard only
    // checked 'completed', so a legitimate PawaPay retry of a FAILED
    // payout would double-credit the user's wallet on every redelivery).
    const withdrawStatus = withdrawSnap.data()?.status
    if (!withdrawSnap.exists || withdrawStatus === 'completed' || withdrawStatus === 'failed') {
      res.status(200).send('Already processed or not found')
      return
    }

    const { userId, amountUsd } = withdrawSnap.data()!
    const now = admin.firestore.FieldValue.serverTimestamp()

    if (status === 'COMPLETED') {
      await db.runTransaction(async tx => {
        tx.update(withdrawRef, { status: 'completed', completedAt: now })
        tx.set(db.collection('transactions').doc(), {
          userId,
          type: 'withdrawal',
          method: 'mobile_money',
          amountUsd,
          currency: 'USD',
          status: 'completed',
          pawapayPayoutId: payoutId,
          feeUsd,
          createdAt: now,
        })
      })
    } else {
      // FAILED — refund wallet
      await db.runTransaction(async tx => {
        tx.update(db.collection('users').doc(userId), {
          walletUsd: admin.firestore.FieldValue.increment(amountUsd),
        })
        tx.update(withdrawRef, { status: 'failed', failedAt: now })
        tx.set(db.collection('transactions').doc(), {
          userId,
          type: 'withdrawal_refund',
          method: 'mobile_money',
          amountUsd,
          currency: 'USD',
          status: 'refunded',
          pawapayPayoutId: payoutId,
          createdAt: now,
        })
      })
    }

    res.status(200).send('OK')
  })
