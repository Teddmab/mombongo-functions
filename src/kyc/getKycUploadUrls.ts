import { admin, functions } from '../lib/admin'

export const getKycUploadUrls = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { fileCount } = data as { fileCount: number }
    if (!fileCount || fileCount < 1 || fileCount > 2)
      throw new functions.https.HttpsError('invalid-argument', 'fileCount must be 1 or 2')

    const timestamp = Date.now()
    const urls = await Promise.all(
      Array.from({ length: fileCount }, async (_, i) => {
        const path = `kyc_documents/${uid}/${timestamp}-${i}.jpg`
        const file = admin.storage().bucket().file(path)

        const [uploadUrl] = await file.getSignedUrl({
          version: 'v4',
          action: 'write',
          expires: Date.now() + 15 * 60 * 1000,
          contentType: 'image/jpeg',
        })

        const [downloadUrl] = await file.getSignedUrl({
          version: 'v4',
          action: 'read',
          expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
        })

        return { uploadUrl, downloadUrl }
      })
    )

    return { urls }
  })
