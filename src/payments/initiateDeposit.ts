import axios from 'axios'
import { admin, db, functions } from '../lib/admin'

const PAWAPAY_BASE = 'https://api.sandbox.pawapay.io'

const OPERATOR_MAP: Record<string, string> = {
  mpesa:  'MPESA_DRC',
  airtel: 'AIRTEL_DRC',
  orange: 'ORANGE_DRC',
}

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

    await db.collection('deposits').doc(depositId).set({
      userId: uid,
      depositId,
      amountUsd,
      currency: 'USD',
      phone,
      operator,
      correspondent,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    const response = await axios.post(
      `${PAWAPAY_BASE}/deposits`,
      {
        depositId,
        amount: String(amountUsd),
        currency: 'USD',
        correspondent,
        payer: { type: 'MSISDN', address: { value: phone } },
        statementDescription: 'Dépôt Mombongo',
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
