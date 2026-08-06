import { admin, functions } from '../lib/admin'

export const getProfilePhotoUploadUrl = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { contentType } = data as { contentType: string }
    if (!contentType?.startsWith('image/'))
      throw new functions.https.HttpsError('invalid-argument', 'Images uniquement')

    const ext = contentType.split('/')[1] ?? 'jpg'
    const path = `profile_photos/${uid}/${Date.now()}.${ext}`
    const file = admin.storage().bucket().file(path)

    const [uploadUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 15 * 60 * 1000,
      contentType,
    })

    const [downloadUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
    })

    return { uploadUrl, downloadUrl }
  })
