import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export interface ScoreBreakdown {
  profileComplete:     { earned: number; max: number; done: boolean }
  kycApproved:         { earned: number; max: number; done: boolean }
  exploitationActive:  { earned: number; max: number; done: boolean }
  bourseListingPublished: { earned: number; max: number; done: boolean }
  academyCoursesCompleted: { earned: number; max: number; done: boolean; count: number }
  priceAlertActivated: { earned: number; max: number; done: boolean }
  bourseTransactionCompleted: { earned: number; max: number; done: boolean }
  activeLoan:          { earned: number; max: number; done: boolean }
}

const UNLOCK_THRESHOLDS: { score: number; feature: string }[] = [
  { score: 40,  feature: 'bourse' },
  { score: 60,  feature: 'financement' },
  { score: 80,  feature: 'preferred_rate' },
  { score: 100, feature: 'certified' },
]

export const getMomBongoScore = functions
  .region('europe-west1')
  .https.onCall(async (_data: unknown, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const [
      userSnap,
      exploitationsSnap,
      listingsSnap,
      certsSnap,
      alertsSnap,
      sellerContractsSnap,
      financingSnap,
    ] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('exploitations').where('farmerId', '==', uid).limit(5).get(),
      db.collection('product_listings').where('farmerId', '==', uid).limit(1).get(),
      db.collection('certificates').where('userId', '==', uid).get(),
      db.collection('farmer_price_alerts').where('farmerId', '==', uid).limit(1).get(),
      db.collection('bourse_contracts').where('sellerId', '==', uid).where('status', '==', 'completed').limit(1).get(),
      db.collection('financing_applications').where('farmerId', '==', uid)
        .where('status', 'in', ['approved', 'disbursed']).limit(1).get(),
    ])

    const user = userSnap.data() ?? {}

    // Profile complete: name + photo + phone
    const hasName  = !!(user.fullName || user.displayName)
    const hasPhoto = !!user.avatarUrl
    const hasPhone = !!user.phone
    const profileDone = hasName && hasPhoto && hasPhone

    // KYC
    const kycDone = user.kycStatus === 'approved'

    // Exploitation active: at least one exploitation with totalHectares > 0 AND at least one culture
    let exploitationDone = false
    for (const explDoc of exploitationsSnap.docs) {
      const expl = explDoc.data()
      if ((expl.totalHectares ?? 0) > 0) {
        const culturesSnap = await db.collection('cultures')
          .where('exploitationId', '==', explDoc.id)
          .limit(1)
          .get()
        if (!culturesSnap.empty) { exploitationDone = true; break }
      }
    }

    // Bourse listing published
    const listingDone = !listingsSnap.empty

    // Academia courses completed (+5 each, max 15 = 3 courses)
    const certCount = certsSnap.size
    const academyEarned = Math.min(certCount * 5, 15)
    const academyDone   = certCount >= 1

    // Price alert activated
    const alertDone = !alertsSnap.empty

    // Bourse transaction completed
    const txDone = !sellerContractsSnap.empty

    // Active loan
    const loanDone = !financingSnap.empty

    const breakdown: ScoreBreakdown = {
      profileComplete:            { earned: profileDone  ? 20 : 0, max: 20, done: profileDone },
      kycApproved:                { earned: kycDone      ? 20 : 0, max: 20, done: kycDone },
      exploitationActive:         { earned: exploitationDone ? 10 : 0, max: 10, done: exploitationDone },
      bourseListingPublished:     { earned: listingDone  ? 10 : 0, max: 10, done: listingDone },
      academyCoursesCompleted:    { earned: academyEarned, max: 15, done: academyDone, count: certCount },
      priceAlertActivated:        { earned: alertDone    ? 5  : 0, max: 5,  done: alertDone },
      bourseTransactionCompleted: { earned: txDone       ? 15 : 0, max: 15, done: txDone },
      activeLoan:                 { earned: loanDone     ? 10 : 0, max: 10, done: loanDone },
    }

    const score = Object.values(breakdown).reduce((s, v) => s + v.earned, 0)
    const unlockedFeatures = UNLOCK_THRESHOLDS.filter(t => score >= t.score).map(t => t.feature)

    // Persist score so other CFs / admin can read it without re-computing
    await db.collection('users').doc(uid).update({
      momBongoScore: score,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    return { score, breakdown, unlockedFeatures }
  })
