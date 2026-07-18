import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'
import { sendPush } from './sendPush'

const db = admin.firestore()

// ─── Trigger: new investment created ────────────────────────────────────────
// Notifies the investor when their investment is confirmed.

export const onInvestmentCreated = functions
  .region('europe-west1')
  .firestore.document('investments/{investmentId}')
  .onCreate(async snapshot => {
    const data = snapshot.data()
    const { investorId, productTitle, amountUsd } = data

    if (!investorId) return

    await sendPush(
      investorId,
      '✅ Investissement confirmé',
      `Votre investissement de $${amountUsd} dans "${productTitle}" a été confirmé.`,
      { type: 'investment', investmentId: snapshot.id }
    )
  })

// ─── Trigger: new bourse investment created ──────────────────────────────────
// Notifies the investor when their bourse subscription is recorded.

export const onBourseInvestmentCreated = functions
  .region('europe-west1')
  .firestore.document('bourse_investments/{id}')
  .onCreate(async snapshot => {
    const data = snapshot.data()
    const { investorId, opportunityTitle, amountUsd } = data

    if (!investorId) return

    await sendPush(
      investorId,
      '📦 Souscription Bourse confirmée',
      `Votre souscription de $${amountUsd} pour "${opportunityTitle}" a été enregistrée.`,
      { type: 'bourse_investment', id: snapshot.id }
    )
  })

// ─── Trigger: deposit completed ──────────────────────────────────────────────
// Notifies the user when their wallet is credited.

export const onDepositCompleted = functions
  .region('europe-west1')
  .firestore.document('deposits/{depositId}')
  .onUpdate(async change => {
    const before = change.before.data()
    const after = change.after.data()

    if (before.status === after.status) return
    if (after.status !== 'completed') return

    const { userId, amountUsd, method } = after
    if (!userId) return

    const methodLabel = method === 'card' ? 'carte bancaire' : 'mobile money'

    await sendPush(
      userId,
      '💰 Dépôt reçu',
      `$${amountUsd} ont été crédités sur votre portefeuille via ${methodLabel}.`,
      { type: 'deposit', depositId: change.after.id }
    )
  })

// ─── Trigger: financing application status change ────────────────────────────
// Notifies the farmer when their application is approved or rejected.

export const onFinancingStatusChanged = functions
  .region('europe-west1')
  .firestore.document('financing_applications/{appId}')
  .onUpdate(async change => {
    const before = change.before.data()
    const after = change.after.data()

    if (before.status === after.status) return

    const { farmerId } = after
    if (!farmerId) return

    if (after.status === 'approved') {
      await sendPush(
        farmerId,
        '🎉 Financement approuvé !',
        `Votre demande de financement a été approuvée. Consultez l'app pour les détails.`,
        { type: 'financing', appId: change.after.id, status: 'approved' }
      )
    } else if (after.status === 'rejected') {
      await sendPush(
        farmerId,
        '⚠️ Demande non retenue',
        `Votre demande de financement n'a pas été retenue. Consultez l'app pour la raison.`,
        { type: 'financing', appId: change.after.id, status: 'rejected' }
      )
    }
  })

// ─── Scheduled: harvest due tomorrow ────────────────────────────────────────
// Runs every day at 08:00 Kinshasa time (UTC+2 = 06:00 UTC).
// Notifies investors whose investments have harvestDate = tomorrow.

export const onHarvestDue = functions
  .region('europe-west1')
  .pubsub.schedule('0 6 * * *')
  .timeZone('Africa/Kinshasa')
  .onRun(async () => {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(0, 0, 0, 0)
    const dayAfter = new Date(tomorrow)
    dayAfter.setDate(dayAfter.getDate() + 1)

    const snap = await db
      .collection('investments')
      .where('harvestDate', '>=', admin.firestore.Timestamp.fromDate(tomorrow))
      .where('harvestDate', '<', admin.firestore.Timestamp.fromDate(dayAfter))
      .where('status', '==', 'active')
      .get()

    const pushes = snap.docs.map(doc => {
      const { investorId, productTitle, expectedReturnUsd } = doc.data()
      if (!investorId) return Promise.resolve()
      return sendPush(
        investorId,
        '🌾 Récolte demain',
        `"${productTitle}" arrive à maturité demain. Retour attendu : $${expectedReturnUsd}.`,
        { type: 'harvest', investmentId: doc.id }
      )
    })

    await Promise.allSettled(pushes)
  })
