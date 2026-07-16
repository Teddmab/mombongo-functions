import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'

if (!admin.apps.length) admin.initializeApp()
const db = admin.firestore()

// ─── Auth ────────────────────────────────────────────────────────────────────

export const createUserProfile = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const {
      fullName = '',
      email = '',
      role = 'investor',
      preferredLanguage = 'fr',
      avatarUrl = null,
    } = data as {
      fullName?: string
      email?: string
      role?: string
      preferredLanguage?: string
      avatarUrl?: string | null
    }

    await db.collection('users').doc(uid).set(
      {
        uid,
        fullName,
        email,
        role,
        preferredLanguage,
        avatarUrl,
        phone: '',
        kycStatus: 'pending',
        kycVerifiedAt: null,
        mobileMoneyNumber: null,
        mobileMoneyProvider: null,
        fcmTokens: [],
        walletUsd: 0,
        walletCdf: 0,
        totalInvestedUsd: 0,
        totalEarnedUsd: 0,
        referralCode: uid.slice(-6).toUpperCase(),
        referredBy: null,
        isActive: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    )

    return { success: true }
  })

export const getUserProfile = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const snap = await db.collection('users').doc(uid).get()
    if (!snap.exists) return null

    return { uid, ...snap.data() }
  })

// ─── Products ────────────────────────────────────────────────────────────────

export const getProducts = functions
  .region('europe-west1')
  .https.onCall(async (_data, _context) => {
    const snap = await db
      .collection('products')
      .where('status', '==', 'active')
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get()

    const products = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    return { products }
  })

export const getProduct = functions
  .region('europe-west1')
  .https.onCall(async (data, _context) => {
    const { id } = data as { id: string }
    if (!id) throw new functions.https.HttpsError('invalid-argument', 'id required')

    const snap = await db.collection('products').doc(id).get()
    const product = snap.exists ? { id: snap.id, ...snap.data() } : null
    return { product }
  })

// ─── Wallet history ──────────────────────────────────────────────────────────

const TX_LABELS: Record<string, string> = {
  deposit: 'Dépôt Wallet',
  withdrawal: 'Retrait Wallet',
  investment: 'Investissement',
  profit: 'Profit distribué',
  fee: 'Frais',
}

function formatTxDate(ts: admin.firestore.Timestamp | Date | undefined): string {
  if (!ts) return ''
  const d = ts instanceof admin.firestore.Timestamp ? ts.toDate() : ts
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })
}

export const getTransactions = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { limit = 30 } = (data ?? {}) as { limit?: number }

    const snap = await db
      .collection('transactions')
      .where('userId', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(Math.min(limit, 50))
      .get()

    const transactions = snap.docs.map(doc => {
      const d = doc.data()
      const type = (d.type as string) ?? 'fee'
      const productName = d.productName as string | undefined
      const label =
        productName && type === 'investment'
          ? `Investissement — ${productName}`
          : productName && type === 'profit'
            ? `Profit — ${productName}`
            : TX_LABELS[type] ?? type

      return {
        id: doc.id,
        kind: type === 'withdraw' ? 'withdrawal' : type,
        label,
        amount: d.amountUsd ?? 0,
        currency: 'USD' as const,
        date: formatTxDate(d.createdAt),
        status: (d.status as string) ?? 'completed',
      }
    })

    return { transactions }
  })

export const getInvestments = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const snap = await db
      .collection('investments')
      .where('investorId', '==', uid)
      .orderBy('investedAt', 'desc')
      .limit(20)
      .get()

    const now = Date.now()
    const investments = snap.docs.map(doc => {
      const d = doc.data()
      const harvestTs = d.harvestDate as admin.firestore.Timestamp | undefined
      const harvestDate = harvestTs
        ? harvestTs.toDate().toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
        : ''
      const investedTs = d.investedAt as admin.firestore.Timestamp | undefined
      const investedMs = investedTs?.toMillis() ?? now
      const harvestMs = harvestTs?.toMillis() ?? investedMs
      const totalDays = Math.max(1, Math.round((harvestMs - investedMs) / 86_400_000))
      const daysLeft = Math.max(0, Math.ceil((harvestMs - now) / 86_400_000))
      const elapsed = totalDays - daysLeft
      const progress = Math.min(100, Math.round((elapsed / totalDays) * 100))

      return {
        id: doc.id,
        productId: d.productId ?? '',
        name: d.productName ?? 'Investissement',
        location: d.location ?? '',
        amount: d.amountUsd ?? 0,
        currency: 'USD' as const,
        roi: d.roi ?? 0,
        progress,
        daysLeft,
        harvestDate,
        category: d.category ?? 'agriculture',
      }
    })

    return { investments }
  })

// ─── FCM ─────────────────────────────────────────────────────────────────────

export const registerFcmToken = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { token } = data as { token: string }
    if (!token) throw new functions.https.HttpsError('invalid-argument', 'token required')

    await db.collection('users').doc(uid).update({ fcmToken: token })
    return { success: true }
  })

// ─── Payments (PawaPay) ───────────────────────────────────────────────────────

export { processWalletPayment }  from './payments/processWalletPayment'
export { initiateDeposit }       from './payments/initiateDeposit'
export { getDepositStatus }      from './payments/getDepositStatus'
export { pawapayWebhook }        from './payments/pawapayWebhook'
export { initiateWithdraw }      from './payments/initiateWithdraw'
export { getWithdrawStatus }     from './payments/getWithdrawStatus'
export { pawapayPayoutWebhook }  from './payments/pawapayPayoutWebhook'
export { pawapayRefundWebhook }  from './payments/pawapayRefundWebhook'

// ─── Product admin ───────────────────────────────────────────────────────────

export { createProduct }       from './products/createProduct'
export { updateProductStatus } from './products/updateProductStatus'
export { getProductsAdmin }    from './products/getProductsAdmin'

// ─── Investments ─────────────────────────────────────────────────────────────

export { createInvestment } from './investments/createInvestment'

export const getInvestments = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const snap = await db
      .collection('investments')
      .where('investorId', '==', uid)
      .orderBy('investedAt', 'desc')
      .limit(50)
      .get()

    const investments = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    return { investments }
  })

// ─── Bourse ──────────────────────────────────────────────────────────────────

export const getBourseOpportunities = functions
  .region('europe-west1')
  .https.onCall(async (_data, _context) => {
    const snap = await db
      .collection('bourse_opportunities')
      .where('status', '==', 'open')
      .orderBy('departureDate', 'asc')
      .limit(20)
      .get()

    const opportunities = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    return { opportunities }
  })

export const getBoursePrices = functions
  .region('europe-west1')
  .https.onCall(async (_data, _context) => {
    const snap = await db
      .collection('bourse_prices')
      .orderBy('recordedAt', 'desc')
      .limit(40)
      .get()

    const prices = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    return { prices }
  })

export const getBourseOpportunity = functions
  .region('europe-west1')
  .https.onCall(async (data, _context) => {
    const { id } = data as { id: string }
    if (!id) throw new functions.https.HttpsError('invalid-argument', 'id required')

    const snap = await db.collection('bourse_opportunities').doc(id).get()
    const opportunity = snap.exists ? { id: snap.id, ...snap.data() } : null
    return { opportunity }
  })

export { createBourseInvestment } from './bourse/createBourseInvestment'
