import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'

const db = admin.firestore()

export const getAcademiaProfile = functions
  .region('europe-west1')
  .https.onCall(async (_, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const enrollSnap = await db.collection('enrollments').where('userId', '==', uid).get()
    const completedCourses = enrollSnap.docs.filter(d => d.data().progressPct === 100).length
    const inProgressCourses = enrollSnap.docs.filter(d => {
      const pct = d.data().progressPct as number
      return pct > 0 && pct < 100
    }).length

    const certsSnap = await db.collection('certificates').where('userId', '==', uid).get()
    const totalXp = certsSnap.docs.reduce((sum, d) => sum + ((d.data().xpEarned as number) ?? 0), 0)

    return { totalXp, completedCourses, inProgressCourses, certificates: certsSnap.size }
  })
