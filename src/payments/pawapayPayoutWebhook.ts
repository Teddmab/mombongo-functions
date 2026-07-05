import * as crypto from 'crypto'
import { admin, db, functions } from '../lib/admin'

export const pawapayPayoutWebhook = functions
  .runWith({ secrets: ['PAWAPAY_WEBHOOK_SECRET'] })
  .region('europe-west1')
  .https.onRequest(async (req, res) => {
    const signature = req.headers['x-pawapay-signature'] as string | undefined
    const secret = process.env.PAWAPAY_WEBHOOK_SECRET

    if (secret && signature) {
      const expected = crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(req.body))
        .digest('hex')
      if (signature !== expected) {
        res.status(401).send('Invalid signature')
        return
      }
    }

    const { payoutId, status } = req.body as { payoutId: string; status: string }
    if (!payoutId) { res.status(400).send('Missing payoutId'); return }

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
