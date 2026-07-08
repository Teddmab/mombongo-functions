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

export const initiateDeposit = functions
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
      throw new functions.https.HttpsError('invalid-argument', 'Minimum deposit $5')
    if (!phone || !operator)
      throw new functions.https.HttpsError('invalid-argument', 'phone and operator required')

    const correspondent = OPERATOR_MAP[operator]
    if (!correspondent)
      throw new functions.https.HttpsError('invalid-argument', `Unknown operator: ${operator}`)

    const depositId = crypto.randomUUID()
    const apiKey = process.env.PAWAPAY_API_KEY
    const amountCdf = Math.round(amountUsd * USD_TO_CDF)

    await db.collection('deposits').doc(depositId).set({
      userId: uid,
      depositId,
      amountUsd,
      amountCdf,
      currency: 'CDF',
      phone,
      operator,
      correspondent,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    const response = await axios.post(
      `${PAWAPAY_BASE}/v1/deposits`,
      {
        depositId,
        amount: String(amountCdf),
        currency: 'CDF',
        correspondent,
        payer: { type: 'MSISDN', address: { value: phone.replace(/\D/g, '') } },
        customerTimestamp: new Date().toISOString(),
        statementDescription: 'Depot Mombongo',
      },
      { headers: { Authorization: `Bearer ${apiKey}` } }
    )

    if (response.data.status !== 'ACCEPTED') {
      await db.collection('deposits').doc(depositId).update({ status: 'failed' })
      const code = response.data.rejectionReason?.rejectionCode ?? 'unknown'
      throw new functions.https.HttpsError('internal', `PawaPay rejected: ${code}`)
    }

    return { depositId, status: 'ACCEPTED' }
  })
