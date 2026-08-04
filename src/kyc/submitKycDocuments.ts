import { admin, functions } from '../lib/admin'

const VALID_DOC_TYPES = ['cni', 'passport', 'permis']

export const submitKycDocuments = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { documentType, photoUrls } = data as {
      documentType: string
      photoUrls: string[]
    }

    if (!VALID_DOC_TYPES.includes(documentType))
      throw new functions.https.HttpsError('invalid-argument', 'Invalid documentType')

    if (!Array.isArray(photoUrls) || photoUrls.length < 1 || photoUrls.length > 2)
      throw new functions.https.HttpsError('invalid-argument', 'photoUrls must have 1 or 2 items')

    const db = admin.firestore()
    const batch = db.batch()

    batch.set(db.collection('kyc_submissions').doc(uid), {
      uid,
      documentType,
      photoUrls,
      status: 'pending',
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
      reviewedAt: null,
      reviewedBy: null,
      rejectionReason: null,
    })

    batch.update(db.collection('users').doc(uid), {
      kycStatus: 'pending',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    await batch.commit()
    return { success: true }
  })
