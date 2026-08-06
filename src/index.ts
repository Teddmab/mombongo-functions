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
        termsAcceptedAt: admin.firestore.FieldValue.serverTimestamp(),
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

// ─── Payments ────────────────────────────────────────────────────────────────

export { processWalletPayment }        from './payments/processWalletPayment'
export { initiateDeposit }             from './payments/initiateDeposit'
export { getDepositStatus }            from './payments/getDepositStatus'
export { pawapayWebhook }              from './payments/pawapayWebhook'
export { initiateWithdraw }            from './payments/initiateWithdraw'
export { getWithdrawStatus }           from './payments/getWithdrawStatus'
export { pawapayPayoutWebhook }        from './payments/pawapayPayoutWebhook'
export { createStripePaymentIntent }   from './payments/createStripePaymentIntent'
export { stripeWebhook }               from './payments/stripeWebhook'

// ─── Push Notifications (FCM triggers) ────────────────────────────────────────

export {
  onInvestmentCreated,
  onBourseInvestmentCreated,
  onDepositCompleted,
  onFinancingStatusChanged,
  onHarvestDue,
} from './notifications/triggers'
export { pawapayRefundWebhook }  from './payments/pawapayRefundWebhook'

// ─── Admin operations ────────────────────────────────────────────────────────

export { setUserRole }       from './admin/setUserRole'
export { disableUser }       from './admin/disableUser'
export { getDashboardKpis }  from './admin/getDashboardKpis'

// ─── Product admin ───────────────────────────────────────────────────────────

export { createProduct }       from './products/createProduct'
export { updateProductStatus } from './products/updateProductStatus'
export { getProductsAdmin }    from './products/getProductsAdmin'

// ─── Investments ─────────────────────────────────────────────────────────────

export { createInvestment } from './investments/createInvestment'

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

export { createBourseInvestment }      from './bourse/createBourseInvestment'

// ─── Agro Exchange (S8) ──────────────────────────────────────────────────────

export { getProductListings, getMyProductListings } from './bourse/getProductListings'
export { getBuyerOrders }                            from './bourse/getBuyerOrders'
export { getBoursePricesByProvince }                 from './bourse/getBoursePricesByProvince'
export { createProductListing }                      from './bourse/createProductListing'
export { getListingPhotoUploadUrl }                  from './bourse/getListingPhotoUploadUrl'
export { createBuyerOrder }                          from './bourse/createBuyerOrder'
export { getMatches }                                from './bourse/getMatches'
export { proposePrice }                              from './bourse/proposePrice'
export { acceptPrice }                               from './bourse/acceptPrice'
export { generateContract }                          from './bourse/generateContract'
export { signContract }                              from './bourse/signContract'
export { fundEscrow }                                from './bourse/fundEscrow'
export { confirmShipment }                           from './bourse/confirmShipment'
export { confirmDelivery }                           from './bourse/confirmDelivery'
export { getContract, getMyContracts }               from './bourse/getContracts'

// ─── Financing ────────────────────────────────────────────────────────────────

export const getFarmers = functions
  .region('europe-west1')
  .https.onCall(async (data, _context) => {
    const { cropType, region, status } = (data ?? {}) as {
      cropType?: string
      region?: string
      status?: string
    }

    let query = db
      .collection('farmers')
      .where('status', 'in', status ? [status] : ['approved', 'active'])
      .orderBy('createdAt', 'desc')
      .limit(50) as FirebaseFirestore.Query

    if (cropType) query = query.where('cropType', '==', cropType)
    if (region)   query = query.where('region', '==', region)

    const snap = await query.get()
    const farmers = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    return { farmers }
  })

export const getFarmer = functions
  .region('europe-west1')
  .https.onCall(async (data, _context) => {
    const { id } = data as { id: string }
    if (!id) throw new functions.https.HttpsError('invalid-argument', 'id required')

    const snap = await db.collection('farmers').doc(id).get()
    return { farmer: snap.exists ? { id: snap.id, ...snap.data() } : null }
  })

export const getCulturalEvents = functions
  .region('europe-west1')
  .https.onCall(async (data, _context) => {
    const { cropType } = (data ?? {}) as { cropType?: string }

    let query = db.collection('cultural_events').orderBy('monthStart', 'asc') as FirebaseFirestore.Query
    if (cropType) query = query.where('cropType', '==', cropType)

    const snap = await query.get()
    return { events: snap.docs.map(d => ({ id: d.id, ...d.data() })) }
  })

export { createFinancingApplication } from './financing/createFinancingApplication'
export { submitAgentReport } from './financing/submitAgentReport'
export { submitUserAction } from './marketplace/submitUserAction'

export const getMyFinancingApplications = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const snap = await db
      .collection('financing_applications')
      .where('investorId', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get()

    return { applications: snap.docs.map(d => ({ id: d.id, ...d.data() })) }
  })

export const getAgentFarmers = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const snap = await db
      .collection('farmers')
      .where('agentId', '==', uid)
      .orderBy('status', 'asc')
      .limit(100)
      .get()

    return { farmers: snap.docs.map(d => ({ id: d.id, ...d.data() })) }
  })

export const getAgentReportUploadUrl = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { filename, contentType } = data as { filename: string; contentType: string }
    if (!contentType.startsWith('image/'))
      throw new functions.https.HttpsError('invalid-argument', 'Images only')

    const path = `agent_reports/${uid}/${Date.now()}-${filename}`
    const [uploadUrl] = await admin.storage().bucket().file(path).getSignedUrl({
      action: 'write',
      expires: Date.now() + 5 * 60 * 1000,
      contentType,
    })

    return { uploadUrl, path }
  })

// ─── Academia ─────────────────────────────────────────────────────────────────

export const getCourses = functions
  .region('europe-west1')
  .https.onCall(async (data, _context) => {
    const { category } = (data ?? {}) as { category?: string }

    let query = db
      .collection('courses')
      .where('status', '==', 'published')
      .orderBy('createdAt', 'desc')
      .limit(30) as FirebaseFirestore.Query

    if (category) query = query.where('category', '==', category)

    const snap = await query.get()
    return { courses: snap.docs.map(d => ({ id: d.id, ...d.data() })) }
  })

export const getCourse = functions
  .region('europe-west1')
  .https.onCall(async (data, _context) => {
    const { id } = data as { id: string }
    if (!id) throw new functions.https.HttpsError('invalid-argument', 'id required')

    const snap = await db.collection('courses').doc(id).get()
    return { course: snap.exists ? { id: snap.id, ...snap.data() } : null }
  })

export const getCourseModules = functions
  .region('europe-west1')
  .https.onCall(async (data, _context) => {
    const { courseId } = data as { courseId: string }
    if (!courseId) throw new functions.https.HttpsError('invalid-argument', 'courseId required')

    const snap = await db
      .collection('courses').doc(courseId)
      .collection('modules')
      .orderBy('order', 'asc')
      .get()

    return { modules: snap.docs.map(d => ({ id: d.id, ...d.data() })) }
  })

export const getMyEnrollment = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { courseId } = data as { courseId: string }
    if (!courseId) throw new functions.https.HttpsError('invalid-argument', 'courseId required')

    const snap = await db.collection('enrollments')
      .where('userId', '==', uid)
      .where('courseId', '==', courseId)
      .limit(1)
      .get()

    return { enrollment: snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() } }
  })

export { enrollCourse }       from './academia/enrollCourse'
export { markModuleComplete } from './academia/markModuleComplete'

// ─── Market Intelligence (S9) ────────────────────────────────────────────────

export { getPriceHistory }              from './intelligence/getPriceHistory'
export { scheduleDailyPriceSnapshot }   from './intelligence/scheduleDailyPriceSnapshot'
export { getMarketStats }               from './intelligence/getMarketStats'
export { createPriceAlert }             from './intelligence/createPriceAlert'
export { cancelPriceAlert }             from './intelligence/cancelPriceAlert'
export { getMyPriceAlerts }             from './intelligence/getMyPriceAlerts'
export { checkPriceAlerts }             from './intelligence/checkPriceAlerts'

// ─── Mon Exploitation (S10) ──────────────────────────────────────────────────

export { getMyExploitations }            from './exploitation/getMyExploitations'
export { getMyExploitation }             from './exploitation/getMyExploitation'
export { saveMyExploitation }            from './exploitation/saveMyExploitation'
export { getMyCultures }                 from './exploitation/getMyCultures'
export { saveCulture }                   from './exploitation/saveCulture'
export { deleteCulture }                 from './exploitation/deleteCulture'
export { getExploitationPhotoUploadUrl } from './exploitation/getExploitationPhotoUploadUrl'
