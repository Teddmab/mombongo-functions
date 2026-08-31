import * as crypto from 'crypto'
import { admin, db, functions } from '../lib/admin'
import { markExternalInvoicePaid, markExternalInvoiceFailed } from '../partners/markExternalInvoicePaid'

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

    // SAI-02: PawaPay's webhook payload has no metadata, so an
    // external-invoice deposit (vs. a Mombongo user's own deposits/{id}
    // doc) is identified by providerRef instead — one extra query, only
    // on this webhook path.
    const invoiceQuery = await db
      .collection('external_invoices')
      .where('providerRef', '==', depositId)
      .limit(1)
      .get()

    if (!invoiceQuery.empty) {
      const invoiceDoc = invoiceQuery.docs[0]
      const invoice = invoiceDoc.data()

      if (status !== 'COMPLETED') {
        await markExternalInvoiceFailed(invoiceDoc.ref)
        res.status(200).send('OK')
        return
      }

      const partnerSnap = await db.collection('partners').doc(invoice.partnerId).get()
      const merchantUid = partnerSnap.data()?.merchantUid as string | undefined
      if (!merchantUid) {
        functions.logger.error(`No merchantUid configured for partner ${invoice.partnerId}`)
        res.status(200).send('Partner not fully provisioned')
        return
      }

      // Runs INSTEAD OF the deposits/{depositId} walletUsd-increment flow
      // below — never in addition to it. No wallet credited; a
      // transactions doc is still written for visibility, against the
      // shared partner merchant account.
      await markExternalInvoicePaid({
        invoiceRef: invoiceDoc.ref,
        merchantUid,
        partnerId: invoice.partnerId,
        amountUsd: invoice.amountUsd,
        method: 'mobile_money',
        providerRefField: 'pawapayDepositId',
        providerRef: depositId,
      })
      // SAI-04's Firestore trigger reacts to the status: 'paid' write
      // above — no direct notifier call from here.
      res.status(200).send('OK')
      return
    }

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
