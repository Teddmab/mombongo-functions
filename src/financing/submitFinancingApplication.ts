import { admin, functions } from '../lib/admin'

const db = admin.firestore()

const VALID_PURPOSES = ['semences', 'engrais', 'équipement', 'irrigation', 'autre']
const VALID_DURATIONS = [3, 6, 9, 12]

export const submitFinancingApplication = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { cropType, surfaceHa, purpose, requestedAmountUsd, durationMonths, province, description } = data as {
      cropType: string
      surfaceHa: number
      purpose: string
      requestedAmountUsd: number
      durationMonths: number
      province: string
      description?: string
    }

    if (!cropType || !surfaceHa || !purpose || !requestedAmountUsd || !durationMonths || !province)
      throw new functions.https.HttpsError('invalid-argument', 'Tous les champs obligatoires sont requis')
    if (!VALID_PURPOSES.includes(purpose))
      throw new functions.https.HttpsError('invalid-argument', 'Objet de financement invalide')
    if (!VALID_DURATIONS.includes(durationMonths))
      throw new functions.https.HttpsError('invalid-argument', 'Durée invalide')
    if (requestedAmountUsd < 50)
      throw new functions.https.HttpsError('invalid-argument', 'Montant minimum: $50')

    // Block duplicate active applications
    const existing = await db.collection('financing_applications')
      .where('farmerId', '==', uid)
      .where('status', 'in', ['pending', 'approved', 'disbursing', 'disbursed'])
      .limit(1)
      .get()
    if (!existing.empty)
      throw new functions.https.HttpsError('already-exists', 'Vous avez déjà une demande en cours')

    const farmerSnap = await db.collection('users').doc(uid).get()
    const farmerData = farmerSnap.data() ?? {}
    const farmerName = ((farmerData.displayName ?? farmerData.fullName) as string | undefined) ?? ''
    const agentId = (farmerData.agentId as string | undefined) ?? null

    const ref = await db.collection('financing_applications').add({
      farmerId: uid,
      farmerName,
      cropType,
      surfaceHa,
      purpose,
      requestedAmountUsd,
      requestedAmount: requestedAmountUsd,
      durationMonths,
      province,
      description: description ?? '',
      status: 'pending',
      agentId,
      tranches: [],
      disbursedAmountUsd: 0,
      disbursedAmount: 0,
      commodity: cropType,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    return { applicationId: ref.id }
  })
