import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'
import { writeNotifAndPush } from './statusTriggers'

const db = admin.firestore()

/**
 * Nothing wrote a notification when an invoice was created, for any
 * origin — a farmer (or merchant, if a real logged-in account) had no way
 * to find out a sale happened except by opening the right screen and
 * happening to look. One trigger covers every creation path
 * (harvest_sale, partner_api, admin_assisted) since it watches the
 * collection, not a specific calling function.
 */
export const onExternalInvoiceCreated = functions
  .region('europe-west1')
  .firestore.document('external_invoices/{invoiceId}')
  .onCreate(async (snap, context) => {
    const invoice = snap.data()
    const invoiceId = context.params.invoiceId as string
    const amountLabel = `${invoice.amountUsd} $`
    const commodityLabel = (invoice.commodity as string) || 'votre récolte'

    const farmerIds: string[] = Array.isArray(invoice.farmers)
      ? (invoice.farmers as { farmerId: string }[]).map((f) => f.farmerId)
      : invoice.farmerId ? [invoice.farmerId as string] : []

    await Promise.all(farmerIds.map((farmerId) =>
      writeNotifAndPush(
        `invoice_created_farmer_${invoiceId}_${farmerId}`,
        farmerId,
        'invoice_issued',
        'Facture créée',
        `Une facture de ${amountLabel} a été créée pour ${commodityLabel}.`,
        { screen: 'bourse', invoiceId },
      ),
    ))

    // Never notify a partner's own synthetic merchant account (isApiAccount)
    // — nobody logs in as it, and it's already told about the invoice via
    // notifyPartnerInvoiceIssued's webhook (separate from this in-app
    // notification, which is for a real human to see on their home screen).
    if (invoice.merchantId) {
      const merchantSnap = await db.collection('users').doc(invoice.merchantId as string).get()
      if (merchantSnap.exists && !merchantSnap.data()?.isApiAccount) {
        await writeNotifAndPush(
          `invoice_created_merchant_${invoiceId}`,
          invoice.merchantId as string,
          'invoice_issued',
          'Nouvelle facture à payer',
          `Une facture de ${amountLabel} vous attend pour ${commodityLabel}.`,
          { screen: 'bourse', invoiceId },
        )
      }
    }
  })
