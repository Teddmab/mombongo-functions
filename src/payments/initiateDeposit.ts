import axios from 'axios'
import { admin, db, functions } from '../lib/admin'

const PAWAPAY_BASE = process.env.PAWAPAY_ENV === 'sandbox'
  ? 'https://api.sandbox.pawapay.io'
  : 'https://api.pawapay.cloud'

// PawaPay DRC correspondent codes (all settle in CDF)
const OPERATOR_MAP: Record<string, string> = {
  mpesa:  'VODACOM_MPESA_COD',
  airtel: 'AIRTEL_COD',
  orange: 'ORANGE_COD',
}

/**
 * Reads the live USD→CDF exchange rate from config/exchange_rate in Firestore.
 * Falls back to 2800 with a warning if the document is absent or the value is invalid.
 */
export async function getUsdToCdf(firestoreDb: FirebaseFirestore.Firestore): Promise<number> {
  try {
    const snap = await firestoreDb.collection('config').doc('exchange_rate').get()
    if (!snap.exists) {
      console.warn('[initiateDeposit] config/exchange_rate not found — using fallback rate 2800')
      return 2800
    }
    const rate = snap.data()?.usdToCdf
    if (typeof rate !== 'number' || rate <= 0) {
      console.warn(`[initiateDeposit] config/exchange_rate.usdToCdf invalid (${rate}) — using fallback 2800`)
      return 2800
    }
    return rate
  } catch (err) {
    console.warn('[initiateDeposit] Failed to read exchange rate — using fallback 2800', err)
    return 2800
  }
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
    const usdToCdf = await getUsdToCdf(db)
    const amountCdf = Math.round(amountUsd * usdToCdf)

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

    let response
    try {
      response = await axios.post(
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
    } catch (err: any) {
      await db.collection('deposits').doc(depositId).update({ status: 'failed' })
      const status = err?.response?.status
      if (status === 401) {
        throw new functions.https.HttpsError('internal', 'PawaPay API key invalide ou expiré.')
      }
      throw new functions.https.HttpsError('internal', `Erreur PawaPay (${status ?? 'réseau'}). Réessayez.`)
    }

    if (response.data.status !== 'ACCEPTED') {
      await db.collection('deposits').doc(depositId).update({ status: 'failed' })
      const code = response.data.rejectionReason?.rejectionCode ?? 'unknown'
      throw new functions.https.HttpsError('internal', `PawaPay rejeté: ${code}`)
    }

    return { depositId, status: 'ACCEPTED' }
  })
