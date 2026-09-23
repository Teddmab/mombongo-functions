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

    if (!withdrawSnap.exists || withdrawSnap.data()?.status === 'completed') {
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
