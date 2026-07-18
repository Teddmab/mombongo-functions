import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'
import Stripe from 'stripe'

const db = admin.firestore()

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new functions.https.HttpsError('internal', 'Stripe not configured')
  return new Stripe(key, { apiVersion: '2026-06-24.dahlia' as any })
}

export const createStripePaymentIntent = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { amountUsd, depositId } = data as { amountUsd: number; depositId: string }
    if (!amountUsd || amountUsd < 5)
      throw new functions.https.HttpsError('invalid-argument', 'Minimum deposit $5')
    if (!depositId)
      throw new functions.https.HttpsError('invalid-argument', 'depositId required')

    // Verify the deposit belongs to this user and is pending
    const depositSnap = await db.collection('deposits').doc(depositId).get()
    if (!depositSnap.exists || depositSnap.data()?.userId !== uid)
      throw new functions.https.HttpsError('not-found', 'Deposit not found')
    if (depositSnap.data()?.status !== 'pending')
      throw new functions.https.HttpsError('failed-precondition', 'Deposit already processed')

    const stripe = getStripe()
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amountUsd * 100),
      currency: 'usd',
      metadata: { uid, depositId },
      automatic_payment_methods: { enabled: true },
    })

    return { clientSecret: paymentIntent.client_secret }
  })
