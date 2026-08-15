import { admin, functions } from '../lib/admin'
import { sendPush } from '../notifications/sendPush'

const db = admin.firestore()
const FieldValue = admin.firestore.FieldValue

export const joinCooperativeLot = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { lotId, contributionKg } = (data ?? {}) as { lotId: string; contributionKg: number }

    if (!lotId) throw new functions.https.HttpsError('invalid-argument', 'lotId required')
    if (!contributionKg || contributionKg <= 0) throw new functions.https.HttpsError('invalid-argument', 'contributionKg must be > 0')

    const userSnap = await db.collection('users').doc(uid).get()
    const displayName: string = userSnap.data()?.displayName ?? userSnap.data()?.fullName ?? 'Agriculteur'

    const lotRef = db.collection('cooperative_lots').doc(lotId)

    let newStatus: string
    let allMemberIds: string[]
    let commodity: string

    await db.runTransaction(async tx => {
      const lotSnap = await tx.get(lotRef)
      if (!lotSnap.exists) throw new functions.https.HttpsError('not-found', 'Lot not found')
      const lot = lotSnap.data()!

      if (lot.status !== 'open') throw new functions.https.HttpsError('failed-precondition', 'Lot is no longer open')
      if ((lot.memberIds as string[]).includes(uid)) throw new functions.https.HttpsError('already-exists', 'Already a member of this lot')

      const newCurrentKg: number = lot.currentKg + contributionKg
      if (newCurrentKg > lot.totalTargetKg * 1.1) {
        throw new functions.https.HttpsError('invalid-argument', `Contribution exceeds lot capacity (max ${Math.floor(lot.totalTargetKg * 1.1 - lot.currentKg)} kg remaining)`)
      }

      newStatus = newCurrentKg >= lot.totalTargetKg ? 'full' : 'open'
      allMemberIds = [...(lot.memberIds as string[]), uid]
      commodity = lot.commodity

      tx.update(lotRef, {
        currentKg: newCurrentKg,
        status: newStatus,
        members: FieldValue.arrayUnion({
          farmerId: uid,
          displayName,
          contributionKg,
          confirmed: false,
          joinedAt: admin.firestore.Timestamp.now(),
        }),
        memberIds: FieldValue.arrayUnion(uid),
      })
    })

    if (newStatus! === 'full') {
      await Promise.all(
        allMemberIds!.map(memberId =>
          sendPush(
            memberId,
            'Lot complet 🎉',
            `Votre vente groupée de ${commodity!} est prête — trouvez un acheteur maintenant !`,
            { lotId, type: 'coop_lot_full' }
          ).catch(() => null)
        )
      )
    }

    return { currentKg: (await lotRef.get()).data()!.currentKg, status: newStatus! }
  })
