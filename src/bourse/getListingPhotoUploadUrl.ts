import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const getListingPhotoUploadUrl = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { listingId, fileName, contentType } = data as {
      listingId: string
      fileName: string
      contentType: string
    }

    if (!contentType.startsWith('image/'))
      throw new functions.https.HttpsError('invalid-argument', 'Images uniquement')

    const bucket = admin.storage().bucket()
    const filePath = `listings/${uid}/${listingId}/${Date.now()}-${fileName}`
    const file = bucket.file(filePath)

    const [uploadUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 15 * 60 * 1000,
      contentType,
    })

    const [readUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
    })

    await db.collection('product_listings').doc(listingId).update({
      photoUrls: admin.firestore.FieldValue.arrayUnion(readUrl),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    return { uploadUrl, readUrl, filePath }
  })
