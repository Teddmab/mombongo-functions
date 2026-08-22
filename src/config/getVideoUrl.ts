import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const getVideoUrl = functions
  .region('europe-west1')
  .https.onCall(async (data, _context) => {
    const { slug } = (data ?? {}) as { slug?: string }
    if (!slug) throw new functions.https.HttpsError('invalid-argument', 'slug required')

    const snap = await db.collection('videos').doc(slug).get()

    if (!snap.exists) {
      throw new functions.https.HttpsError('not-found', `Vidéo introuvable: ${slug}`)
    }

    const doc = snap.data()!
    const storagePath = doc.storagePath as string
    if (!storagePath) {
      throw new functions.https.HttpsError('internal', 'storagePath manquant')
    }

    const bucket = admin.storage().bucket()
    const publicUrl =
      `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
      `${encodeURIComponent(storagePath)}?alt=media`

    return {
      url: publicUrl,
      title: (doc.title as string | undefined) ?? slug,
      durationSec: (doc.durationSec as number | undefined) ?? 0,
    }
  })
