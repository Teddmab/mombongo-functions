import { admin, auth, db, functions } from '../lib/admin'

const CREATABLE_ROLES = ['farmer', 'merchant'] as const
type CreatableRole = typeof CREATABLE_ROLES[number]

const CONSENT_METHODS = ['phone', 'in_person', 'field_agent'] as const
type ConsentMethod = typeof CONSENT_METHODS[number]

interface AdminCreatePersonInput {
  role: CreatableRole
  fullName: string
  phone: string
  email?: string
  province?: string // farmer only
  businessType?: string // merchant only
  consentMethod: ConsentMethod
  consentAt: string // ISO
  note?: string
}

/**
 * ADM-UI-04's "créer un agriculteur / commerçant" — used from the assisted
 * invoice wizard when the counterparty isn't already on the platform (a
 * farmer selling for the first time via a field agent, or a merchant an
 * admin is onboarding on the spot). Deliberately narrow: only 'farmer' and
 * 'merchant' can be created this way — never 'admin', 'investor' or 'agent'.
 *
 * These accounts are real, immediately usable Mombongo accounts (Teddy's
 * call: admin-attested and unblocked right away, not held behind a second
 * KYC step nobody would ever complete for them) — but every one is
 * unambiguously flagged as such, never disguised as ordinary self-service
 * KYC:
 *   - kycStatus: 'approved' + kycVerifiedAt is set immediately, so the
 *     account can transact (list a harvest, receive an invoice, get paid)
 *     the moment it's created.
 *   - adminCreated: true, createdBy: <admin uid>, verificationMethod:
 *     'admin_attested' — a permanent, queryable marker distinguishing this
 *     from a farmer/merchant who verified their own ID.
 *   - adminAssisted.{consentMethod, consentAt, note} — the same consent
 *     trail adminCreateAssistedInvoice records, because creating the
 *     account and creating the invoice are two halves of one assisted
 *     transaction.
 *
 * Login-less by construction, same as provisionPartnerCore's synthetic
 * merchant accounts: no password is ever set, and nothing here mints a
 * client-facing session. The person can still be onboarded to real
 * self-service login later (password reset by email, once they have one)
 * without this function's involvement.
 */
export const adminCreatePerson = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const adminUid = context.auth?.uid
    if (!adminUid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const callerSnap = await db.collection('users').doc(adminUid).get()
    if (callerSnap.data()?.role !== 'admin')
      throw new functions.https.HttpsError('permission-denied', 'Admin only')

    const {
      role, fullName, phone, email, province, businessType, consentMethod, consentAt, note,
    } = (data ?? {}) as Partial<AdminCreatePersonInput>

    if (!role || !CREATABLE_ROLES.includes(role))
      throw new functions.https.HttpsError('invalid-argument', `role must be one of ${CREATABLE_ROLES.join(', ')}`)
    if (!fullName?.trim()) throw new functions.https.HttpsError('invalid-argument', 'fullName required')
    if (!phone?.trim()) throw new functions.https.HttpsError('invalid-argument', 'phone required')
    if (!consentMethod || !CONSENT_METHODS.includes(consentMethod))
      throw new functions.https.HttpsError('invalid-argument', `consentMethod must be one of ${CONSENT_METHODS.join(', ')}`)
    if (!consentAt) throw new functions.https.HttpsError('invalid-argument', 'consentAt required')

    const normalizedPhone = phone.trim()

    // A retry (double-click, flaky connection) should reuse the same
    // person rather than mint a duplicate account for the same phone+role.
    const dupeSnap = await db.collection('users')
      .where('role', '==', role)
      .where('phone', '==', normalizedPhone)
      .limit(1)
      .get()
    if (!dupeSnap.empty) {
      const existing = dupeSnap.docs[0]
      return { uid: existing.id, isNew: false, fullName: existing.data().fullName as string }
    }

    const digits = normalizedPhone.replace(/[^0-9]/g, '')
    const syntheticEmail = email?.trim() || `p${digits}-${role}@admin-created.mombongo.internal`

    let userRecord
    try {
      userRecord = await auth.getUserByEmail(syntheticEmail)
    } catch {
      userRecord = await auth.createUser({
        email: syntheticEmail,
        emailVerified: true,
        displayName: fullName.trim(),
        disabled: false,
      })
    }
    const uid = userRecord.uid

    const now = admin.firestore.FieldValue.serverTimestamp()
    await db.collection('users').doc(uid).set({
      uid,
      fullName: fullName.trim(),
      email: syntheticEmail,
      role,
      roles: [role],
      preferredLanguage: 'fr',
      avatarUrl: null,
      phone: normalizedPhone,
      province: role === 'farmer' ? (province?.trim() || null) : null,
      cropType: null,
      businessType: role === 'merchant' ? (businessType?.trim() || null) : null,
      country: 'CD',
      kycStatus: 'approved',
      kycVerifiedAt: now,
      onboardingComplete: role === 'farmer' ? false : true,
      primaryGoal: null,
      mobileMoneyNumber: null,
      mobileMoneyProvider: null,
      fcmTokens: [],
      walletUsd: 0,
      walletCdf: 0,
      totalInvestedUsd: 0,
      totalEarnedUsd: 0,
      referralCode: uid.slice(-6).toUpperCase(),
      referredBy: null,
      isActive: true,
      adminCreated: true,
      createdBy: adminUid,
      verificationMethod: 'admin_attested',
      adminAssisted: {
        actorUid: adminUid,
        consentMethod,
        consentAt: admin.firestore.Timestamp.fromDate(new Date(consentAt)),
        note: note ?? null,
      },
      termsAcceptedAt: now,
      createdAt: now,
      updatedAt: now,
    }, { merge: true })

    functions.logger.info(`adminCreatePerson: ${adminUid} created ${role} ${uid} (${fullName.trim()})`)
    return { uid, isNew: true, fullName: fullName.trim() }
  })
