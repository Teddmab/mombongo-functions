import { admin, functions } from '../lib/admin'

export const updateUserProfile = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { avatarUrl, phone, mobileMoneyNumber } = data as {
      avatarUrl?: string
      phone?: string
      mobileMoneyNumber?: string
    }

    const updates: Record<string, unknown> = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }
    if (avatarUrl !== undefined) updates.avatarUrl = avatarUrl
    if (phone !== undefined) updates.phone = phone
    if (mobileMoneyNumber !== undefined) updates.mobileMoneyNumber = mobileMoneyNumber

    await admin.firestore().collection('users').doc(uid).update(updates)
    return { success: true }
  })
