import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'

const db = admin.firestore()

export const markModuleComplete = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { courseId, moduleId } = data as { courseId: string; moduleId: string }
    if (!courseId || !moduleId)
      throw new functions.https.HttpsError('invalid-argument', 'courseId and moduleId required')

    const enrollSnap = await db.collection('enrollments')
      .where('userId', '==', uid)
      .where('courseId', '==', courseId)
      .limit(1)
      .get()

    if (enrollSnap.empty)
      throw new functions.https.HttpsError('not-found', 'Not enrolled in this course')

    const enrollDoc = enrollSnap.docs[0]
    const enrollment = enrollDoc.data()

    if ((enrollment.completedModules as string[]).includes(moduleId))
      return { success: true, progressPct: enrollment.progressPct, isCompleted: enrollment.progressPct === 100 }

    const modulesSnap = await db
      .collection('courses').doc(courseId)
      .collection('modules').get()
    const totalModules = modulesSnap.size

    const completed = [...(enrollment.completedModules as string[]), moduleId]
    const progressPct = Math.round((completed.length / totalModules) * 100)
    const isCompleted = progressPct === 100

    await enrollDoc.ref.update({
      completedModules: admin.firestore.FieldValue.arrayUnion(moduleId),
      progressPct,
      ...(isCompleted ? { completedAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
    })

    return { success: true, progressPct, isCompleted }
  })
