import * as crypto from 'crypto'
import { admin, db, functions } from '../lib/admin'

export const pawapayWebhook = functions
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

    const { depositId, status } = req.body as { depositId: string; status: string }
    if (!depositId) { res.status(400).send('Missing depositId'); return }

    if (status !== 'COMPLETED') {
      await db.collection('deposits').doc(depositId).update({ status: 'failed' })
      res.status(200).send('OK')
      return
    }

    const depositRef = db.collection('deposits').doc(depositId)
    const depositSnap = await depositRef.get()

    if (!depositSnap.exists || depositSnap.data()?.status !== 'pending') {
      res.status(200).send('Already processed')
      return
    }

    const { userId, amountUsd } = depositSnap.data()!
    const now = admin.firestore.FieldValue.serverTimestamp()

    await db.runTransaction(async tx => {
      tx.update(db.collection('users').doc(userId), {
        walletUsd: admin.firestore.FieldValue.increment(amountUsd),
      })
      tx.update(depositRef, { status: 'completed', completedAt: now })
      tx.set(db.collection('transactions').doc(), {
        userId,
        type: 'deposit',
        method: 'mobile_money',
        amountUsd,
        currency: 'USD',
        status: 'completed',
        pawapayDepositId: depositId,
        createdAt: now,
      })
    })

    res.status(200).send('OK')
  })
