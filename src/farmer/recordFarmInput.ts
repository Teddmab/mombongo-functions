import { admin, functions } from '../lib/admin'

const db = admin.firestore()
const FieldValue = admin.firestore.FieldValue

type InputType = 'semences' | 'engrais' | 'pesticide' | 'main-oeuvre' | 'location-equipement' | 'autre'
const VALID_TYPES: InputType[] = ['semences', 'engrais', 'pesticide', 'main-oeuvre', 'location-equipement', 'autre']

export const recordFarmInput = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const {
      cultureId,
      inputType,
      inputName,
      costCdf,
      quantityKg,
      unitCount,
      growthStage,
      notes,
    } = (data ?? {}) as {
      cultureId: string
      inputType: InputType
      inputName: string
      costCdf: number
      quantityKg?: number
      unitCount?: number
      growthStage?: string
      notes?: string
    }

    if (!cultureId) throw new functions.https.HttpsError('invalid-argument', 'cultureId required')
    if (!inputName?.trim()) throw new functions.https.HttpsError('invalid-argument', 'inputName required')
    if (!costCdf || costCdf <= 0) throw new functions.https.HttpsError('invalid-argument', 'costCdf must be > 0')
    if (!inputType || !VALID_TYPES.includes(inputType)) throw new functions.https.HttpsError('invalid-argument', 'invalid inputType')

    const cultureSnap = await db.collection('cultures').doc(cultureId).get()
    if (!cultureSnap.exists) throw new functions.https.HttpsError('not-found', 'Culture not found')
    const culture = cultureSnap.data()!
    if (culture.farmerId !== uid) throw new functions.https.HttpsError('not-found', 'Culture not found')

    const ref = db.collection('farm_inputs').doc()
    const now = FieldValue.serverTimestamp()

    await ref.set({
      farmerId: uid,
      cultureId,
      exploitationId: culture.exploitationId ?? null,
      inputType,
      inputName: inputName.trim(),
      quantityKg: quantityKg ?? null,
      unitCount: unitCount ?? null,
      costCdf,
      growthStage: growthStage ?? null,
      notes: notes ?? null,
      recordedAt: now,
      createdAt: now,
    })

    return { inputId: ref.id }
  })
