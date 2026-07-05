import * as crypto from 'crypto'
import { admin, db, functions } from '../lib/admin'

export const pawapayRefundWebhook = functions
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

    const { refundId, depositId, status } = req.body as {
      refundId: string
      depositId: string
      status: string
    }

    if (!refundId) { res.status(400).send('Missing refundId'); return }

    const now = admin.firestore.FieldValue.serverTimestamp()

    // Look up the original deposit to find userId + amount
    const depositSnap = await db.collection('deposits').doc(depositId).get()
    const { userId, amountUsd } = depositSnap.exists
      ? (depositSnap.data() as { userId: string; amountUsd: number })
      : { userId: null, amountUsd: 0 }

    if (status === 'COMPLETED') {
      // Refund sent back to customer — deduct from their wallet if it was credited
      await db.runTransaction(async tx => {
        if (userId) {
          tx.update(db.collection('users').doc(userId), {
            walletUsd: admin.firestore.FieldValue.increment(-amountUsd),
          })
        }
        tx.set(db.collection('transactions').doc(), {
          userId,
          type: 'deposit_refund',
          method: 'mobile_money',
          amountUsd,
          currency: 'USD',
          status: 'refunded',
          pawapayRefundId: refundId,
          pawapayDepositId: depositId,
          createdAt: now,
        })
        tx.set(db.collection('refunds').doc(refundId), {
          refundId,
          depositId,
          userId,
          amountUsd,
          status: 'completed',
          completedAt: now,
        })
      })
    } else {
      // Refund FAILED — record it, wallet stays credited
      await db.collection('refunds').doc(refundId).set({
        refundId,
        depositId,
        userId,
        amountUsd,
        status: 'failed',
        failedAt: now,
      })
    }

    res.status(200).send('OK')
  })
