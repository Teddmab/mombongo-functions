import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export interface DashboardKpisResult {
  activeUsers: number
  pendingKyc: number
  financingOpen: number
  bourseOpen: number
  monthlyVolumeUsd: number
  totalDepositsUsd: number
  platformRevenueUsd: number
  activeInvestments: number
}

export const getDashboardKpis = functions
  .region('europe-west1')
  .https.onCall(async (_data: unknown, context): Promise<DashboardKpisResult> => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Login required')
    }

    const startOfMonth = new Date()
    startOfMonth.setDate(1)
    startOfMonth.setHours(0, 0, 0, 0)
    const startTs = admin.firestore.Timestamp.fromDate(startOfMonth)

    const [
      activeSnap,
      kycSnap,
      financingSnap,
      bourseSnap,
      txSnap,
      depositSnap,
      investSnap,
    ] = await Promise.all([
      db.collection('users').where('disabled', '!=', true).count().get(),
      // Real submitted dossiers actually awaiting a decision (kyc_submissions),
      // not users.kycStatus === 'pending' — that field also covers everyone who
      // simply hasn't started KYC yet, so it overcounted vs. what
      // reviewKycSubmission's queue (AdminKyc) can actually show an admin.
      db.collection('kyc_submissions').where('status', '==', 'pending').count().get(),
      db.collection('financing_applications').where('status', '==', 'active').count().get(),
      db.collection('bourse_opportunities').where('status', '==', 'open').count().get(),
      db.collection('transactions').where('createdAt', '>=', startTs).get(),
      db.collection('deposits').where('status', '==', 'completed').get(),
      db.collection('investments').where('status', '==', 'active').count().get(),
    ])

    const monthlyVolumeUsd = txSnap.docs.reduce((s, d) => s + ((d.data().amountUsd as number) ?? 0), 0)
    const totalDepositsUsd = depositSnap.docs.reduce((s, d) => s + ((d.data().amountUsd as number) ?? 0), 0)

    return {
      activeUsers: activeSnap.data().count,
      pendingKyc: kycSnap.data().count,
      financingOpen: financingSnap.data().count,
      bourseOpen: bourseSnap.data().count,
      monthlyVolumeUsd,
      totalDepositsUsd,
      platformRevenueUsd: monthlyVolumeUsd * 0.05,
      activeInvestments: investSnap.data().count,
    }
  })
