import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'

const db = admin.firestore()

export const enrollCourse = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { courseId } = data as { courseId: string }
    if (!courseId) throw new functions.https.HttpsError('invalid-argument', 'courseId required')

    const courseSnap = await db.collection('courses').doc(courseId).get()
    if (!courseSnap.exists || courseSnap.data()?.status !== 'published')
      throw new functions.https.HttpsError('not-found', 'Course not available')

    const existing = await db.collection('enrollments')
      .where('userId', '==', uid)
      .where('courseId', '==', courseId)
      .limit(1)
      .get()

    if (!existing.empty) return { success: true, enrollmentId: existing.docs[0].id }

    const now = admin.firestore.FieldValue.serverTimestamp()
    const enrollRef = db.collection('enrollments').doc()

    await db.runTransaction(async tx => {
      tx.set(enrollRef, {
        userId: uid,
        courseId,
        completedModules: [],
        progressPct: 0,
        enrolledAt: now,
        completedAt: null,
      })
      tx.update(db.collection('courses').doc(courseId), {
        enrollmentCount: admin.firestore.FieldValue.increment(1),
      })
    })

    return { success: true, enrollmentId: enrollRef.id }
  })
