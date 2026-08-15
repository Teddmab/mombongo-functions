import { admin, functions } from '../lib/admin'

const db = admin.firestore()
const FieldValue = admin.firestore.FieldValue

export const createAgroAdvisory = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const userSnap = await db.collection('users').doc(uid).get()
    const role = userSnap.data()?.role
    if (role !== 'admin') throw new functions.https.HttpsError('permission-denied', 'Admin only')

    const {
      province,
      commodity,
      growthStage,
      title,
      body,
      severity,
      source,
      effectiveFrom,
      effectiveTo,
    } = (data ?? {}) as {
      province: string
      commodity?: string
      growthStage?: string
      title: string
      body: string
      severity: 'info' | 'warning' | 'critical'
      source: string
      effectiveFrom: string
      effectiveTo: string
    }

    if (!title?.trim()) throw new functions.https.HttpsError('invalid-argument', 'title required')
    if (!body?.trim()) throw new functions.https.HttpsError('invalid-argument', 'body required')
    if (!province?.trim()) throw new functions.https.HttpsError('invalid-argument', 'province required')
    if (!['info', 'warning', 'critical'].includes(severity)) throw new functions.https.HttpsError('invalid-argument', 'invalid severity')
    if (!effectiveFrom || !effectiveTo) throw new functions.https.HttpsError('invalid-argument', 'effectiveFrom and effectiveTo required')

    const fromDate = new Date(effectiveFrom)
    const toDate = new Date(effectiveTo)
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      throw new functions.https.HttpsError('invalid-argument', 'Invalid dates')
    }
    if (toDate <= fromDate) {
      throw new functions.https.HttpsError('invalid-argument', 'effectiveTo must be after effectiveFrom')
    }

    const ref = db.collection('agro_advisories').doc()
    await ref.set({
      province: province.trim(),
      commodity: commodity?.trim() ?? null,
      growthStage: growthStage?.trim() ?? null,
      title: title.trim(),
      body: body.trim(),
      severity,
      source: source?.trim() ?? '',
      effectiveFrom: admin.firestore.Timestamp.fromDate(fromDate),
      effectiveTo:   admin.firestore.Timestamp.fromDate(toDate),
      createdBy: uid,
      createdAt: FieldValue.serverTimestamp(),
    })

    return { advisoryId: ref.id }
  })
