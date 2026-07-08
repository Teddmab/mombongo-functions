import axios from 'axios'
import { admin, db, functions } from '../lib/admin'

const PAWAPAY_BASE = 'https://api.sandbox.pawapay.io'

// PawaPay DRC correspondent codes (all settle in CDF)
const OPERATOR_MAP: Record<string, string> = {
  mpesa:  'VODACOM_MPESA_COD',
  airtel: 'AIRTEL_COD',
  orange: 'ORANGE_COD',
}

// Fixed USD→CDF rate used for PawaPay submissions (wallet always stored in USD)
const USD_TO_CDF = 2800

export const initiateWithdraw = functions
  .runWith({ secrets: ['PAWAPAY_API_KEY'] })
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { amountUsd, phone, operator } = data as {
      amountUsd: number
      phone: string
      operator: string
    }

    if (!amountUsd || amountUsd < 5)
      throw new functions.https.HttpsError('invalid-argument', 'Minimum withdrawal $5')

    const correspondent = OPERATOR_MAP[operator]
    if (!correspondent)
      throw new functions.https.HttpsError('invalid-argument', 'Unknown operator')

    const payoutId = crypto.randomUUID()
    const userRef = db.collection('users').doc(uid)
    const withdrawRef = db.collection('withdrawals').doc(payoutId)
    const amountCdf = Math.round(amountUsd * USD_TO_CDF)

    // Atomically check balance and reserve funds
    await db.runTransaction(async tx => {
      const userSnap = await tx.get(userRef)
      if (!userSnap.exists)
        throw new functions.https.HttpsError('not-found', 'User not found')

      const walletUsd: number = userSnap.data()?.walletUsd ?? 0
      if (walletUsd < amountUsd)
        throw new functions.https.HttpsError('failed-precondition', 'Insufficient balance')

      const now = admin.firestore.FieldValue.serverTimestamp()
      tx.update(userRef, {
        walletUsd: admin.firestore.FieldValue.increment(-amountUsd),
      })
      tx.set(withdrawRef, {
        userId: uid,
        payoutId,
        amountUsd,
        amountCdf,
        currency: 'CDF',
        phone,
        operator,
        correspondent,
        status: 'pending',
        createdAt: now,
      })
    })

    // Call PawaPay payouts API
    try {
      const response = await axios.post(
        `${PAWAPAY_BASE}/v1/payouts`,
        {
          payoutId,
          amount: String(amountCdf),
          currency: 'CDF',
          correspondent,
          recipient: { type: 'MSISDN', address: { value: phone.replace(/\D/g, '') } },
          customerTimestamp: new Date().toISOString(),
          statementDescription: 'Retrait Mombongo',
        },
        { headers: { Authorization: `Bearer ${process.env.PAWAPAY_API_KEY}` } }
      )

      if (response.data.status !== 'ACCEPTED') {
        // Refund wallet — payout was rejected
        await db.runTransaction(async tx => {
          tx.update(userRef, {
            walletUsd: admin.firestore.FieldValue.increment(amountUsd),
          })
          tx.update(withdrawRef, { status: 'failed' })
        })
        throw new functions.https.HttpsError(
          'internal',
          `PawaPay rejected payout: ${response.data.rejectionReason?.rejectionCode ?? 'unknown'}`
        )
      }

      await withdrawRef.update({ status: 'processing' })
      return { payoutId, status: 'ACCEPTED' }
    } catch (err) {
      // Only refund if it was a non-HttpsError (network failure, etc.)
      if ((err as functions.https.HttpsError).httpErrorCode === undefined) {
        await db.runTransaction(async tx => {
          tx.update(userRef, {
            walletUsd: admin.firestore.FieldValue.increment(amountUsd),
          })
          tx.update(withdrawRef, { status: 'failed' })
        })
        throw new functions.https.HttpsError('internal', 'PawaPay unreachable. Funds returned to wallet.')
      }
      throw err
    }
  })
