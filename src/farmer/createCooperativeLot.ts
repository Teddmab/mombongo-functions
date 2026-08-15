import { admin, functions } from '../lib/admin'

const db = admin.firestore()
const FieldValue = admin.firestore.FieldValue

export const createCooperativeLot = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const {
      commodity,
      totalTargetKg,
      pricePerKgCdf,
      province,
      territory,
      deadline,
      myContributionKg,
      description,
    } = (data ?? {}) as {
      commodity: string
      totalTargetKg: number
      pricePerKgCdf: number
      province: string
      territory: string
      deadline: string
      myContributionKg: number
      description?: string
    }

    if (!commodity?.trim()) throw new functions.https.HttpsError('invalid-argument', 'commodity required')
    if (!totalTargetKg || totalTargetKg < 100) throw new functions.https.HttpsError('invalid-argument', 'totalTargetKg must be ≥ 100')
    if (!pricePerKgCdf || pricePerKgCdf <= 0) throw new functions.https.HttpsError('invalid-argument', 'pricePerKgCdf must be > 0')
    if (!province?.trim() || !territory?.trim()) throw new functions.https.HttpsError('invalid-argument', 'province and territory required')
    if (!myContributionKg || myContributionKg <= 0 || myContributionKg > totalTargetKg) {
      throw new functions.https.HttpsError('invalid-argument', 'myContributionKg must be between 1 and totalTargetKg')
    }

    const deadlineDate = new Date(deadline)
    if (isNaN(deadlineDate.getTime()) || deadlineDate <= new Date()) {
      throw new functions.https.HttpsError('invalid-argument', 'deadline must be a future date')
    }

    const userSnap = await db.collection('users').doc(uid).get()
    const displayName: string = userSnap.data()?.displayName ?? userSnap.data()?.fullName ?? 'Agriculteur'

    const ref = db.collection('cooperative_lots').doc()
    const now = FieldValue.serverTimestamp()

    await ref.set({
      creatorFarmerId: uid,
      commodity: commodity.trim(),
      totalTargetKg,
      currentKg: myContributionKg,
      pricePerKgCdf,
      province: province.trim(),
      territory: territory.trim(),
      status: 'open',
      members: [{ farmerId: uid, displayName, contributionKg: myContributionKg, confirmed: false, joinedAt: admin.firestore.Timestamp.now() }],
      memberIds: [uid],
      deadline: admin.firestore.Timestamp.fromDate(deadlineDate),
      description: description?.trim() ?? null,
      createdAt: now,
    })

    return { lotId: ref.id }
  })
