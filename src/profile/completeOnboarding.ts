import { admin, functions } from '../lib/admin'
const db = admin.firestore()
const FieldValue = admin.firestore.FieldValue

export const completeOnboarding = functions
  .region('europe-west1')
  .https.onCall(async (data: any, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { goal, exploitationName, primaryCrop, province, skipExploitationCreate } = data as {
      goal: 'sell' | 'credit' | 'monitor'
      exploitationName: string
      primaryCrop: string
      province: string
      skipExploitationCreate?: boolean
    }

    if (!goal) throw new functions.https.HttpsError('invalid-argument', 'goal requis')

    const now = FieldValue.serverTimestamp()
    const batch = db.batch()

    let exploitationId: string | null = null

    if (!skipExploitationCreate) {
      if (!province) throw new functions.https.HttpsError('invalid-argument', 'province requise')
      // Create a minimal exploitation (isSetupComplete: false — farmer completes it later)
      const exploitationRef = db.collection('exploitations').doc()
      batch.set(exploitationRef, {
        farmerId: uid,
        name: exploitationName || 'Mon exploitation',
        province,
        territory: '',
        village: '',
        totalHectares: 0,
        type: 'familiale',
        waterAccess: 'pluie',
        workerCount: 0,
        workerType: 'saisonnier',
        notes: '',
        isSetupComplete: false,
        createdAt: now,
        updatedAt: now,
      })
      exploitationId = exploitationRef.id
    }

    // Mark onboarding complete and save primary goal
    const userRef = db.collection('users').doc(uid)
    batch.update(userRef, {
      onboardingComplete: true,
      primaryGoal: goal,
      primaryCrop: primaryCrop || '',
      updatedAt: now,
    })

    await batch.commit()
    return { exploitationId }
  })
