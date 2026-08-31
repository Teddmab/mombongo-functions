import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'
import { sendPush } from './sendPush'

const db = admin.firestore()

async function isStatusUpdateEnabled(uid: string): Promise<boolean> {
  const snap = await db.collection('users').doc(uid).get()
  if (!snap.exists) return true
  const prefs = (snap.data()!.notificationPrefs ?? {}) as Record<string, unknown>
  return prefs.statusUpdates !== false
}

async function writeNotifAndPush(
  eventKey: string,
  uid: string,
  type: string,
  title: string,
  body: string,
  data: Record<string, string>
): Promise<void> {
  const notifRef = db.collection('notifications').doc(eventKey)
  const written = await db.runTransaction(async tx => {
    const snap = await tx.get(notifRef)
    if (snap.exists) return false
    tx.set(notifRef, {
      userId: uid,
      type,
      title,
      body,
      read: false,
      data,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })
    return true
  })
  if (!written) return
  await sendPush(uid, title, body, data)
}

// ─── Trigger: listing receives its first buyer view ──────────────────────────

export const onListingFirstView = functions
  .region('europe-west1')
  .firestore.document('product_listings/{listingId}')
  .onUpdate(async change => {
    const before = change.before.data()
    const after = change.after.data()
    const listingId = change.after.id

    const beforeCount = (before.viewCount as number | undefined) ?? 0
    const afterCount = (after.viewCount as number | undefined) ?? 0

    if (beforeCount !== 0 || afterCount < 1) return

    const sellerId: string = after.sellerId
    if (!sellerId) return

    if (!(await isStatusUpdateEnabled(sellerId))) return

    const commodity = (after.commodity as string | undefined) ?? 'produit'

    await writeNotifAndPush(
      `listing_firstview_${listingId}`,
      sellerId,
      'listing_view',
      '👀 Premier acheteur intéressé',
      `Un acheteur a regardé votre annonce de ${commodity} !`,
      { screen: 'bourse', listingId }
    )
  })

// ─── Trigger: agent report created — notify the farmer ───────────────────────

export const onAgentReportCreated = functions
  .region('europe-west1')
  .firestore.document('agent_reports/{reportId}')
  .onCreate(async snapshot => {
    const data = snapshot.data()
    const reportId = snapshot.id

    const farmerId: string = data.farmerId
    if (!farmerId) return

    if (!(await isStatusUpdateEnabled(farmerId))) return

    await writeNotifAndPush(
      `agentreport_${reportId}`,
      farmerId,
      'agent_report',
      '📝 Rapport de visite reçu',
      'Votre agent a soumis un rapport de visite — consultez ses recommandations.',
      { screen: 'exploitation', reportId }
    )
  })
