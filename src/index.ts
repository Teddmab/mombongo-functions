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
