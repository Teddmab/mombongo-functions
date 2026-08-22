import { admin, functions } from '../lib/admin'
import { sendPush } from '../notifications/sendPush'

const db = admin.firestore()

const TEST_SCENARIOS = {
  financing: {
    title: '📋 Dossier en cours d\'examen',
    body: 'Votre dossier est en cours d\'examen — décision dans 48h.',
    notifType: 'financing_status',
    data: { screen: 'financement', appId: 'test' },
  },
  listing_view: {
    title: '👀 Premier acheteur intéressé',
    body: 'Un acheteur a regardé votre annonce de Maïs !',
    notifType: 'listing_view',
    data: { screen: 'bourse', listingId: 'test' },
  },
  agent_report: {
    title: '📝 Rapport de visite reçu',
    body: 'Votre agent a soumis un rapport de visite — consultez ses recommandations.',
    notifType: 'agent_report',
    data: { screen: 'exploitation', reportId: 'test' },
  },
} as const

export const adminTestStatusPush = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const callerUid = context.auth?.uid
    if (!callerUid)
      throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const callerSnap = await db.collection('users').doc(callerUid).get()
    if (callerSnap.data()?.role !== 'admin')
      throw new functions.https.HttpsError('permission-denied', 'Admin only')

    const { type, targetUid } = (data ?? {}) as { type?: string; targetUid?: string }

    if (!type || !targetUid)
      throw new functions.https.HttpsError('invalid-argument', 'type and targetUid required')

    const scenario = TEST_SCENARIOS[type as keyof typeof TEST_SCENARIOS]
    if (!scenario)
      throw new functions.https.HttpsError('invalid-argument', `Unknown type: ${type}`)

    const { title, body, notifType, data: pushData } = scenario

    // Write in-app notification (no idempotency key — test tool can fire multiple times)
    await db.collection('notifications').add({
      userId: targetUid,
      type: notifType,
      title,
      body,
      read: false,
      data: pushData,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    const result = await sendPush(targetUid, title, body, pushData)

    // Log alongside regular admin push log
    await db.collection('admin_push_log').add({
      title,
      body,
      screen: pushData.screen,
      targetUid,
      targetRole: null,
      results: { sent: result.sent, failed: result.failed, noTokens: result.noTokens ? 1 : 0 },
      sentBy: callerUid,
      testType: type,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    return { sent: result.sent, failed: result.failed, noTokens: result.noTokens }
  })
