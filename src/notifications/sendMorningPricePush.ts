import { admin, functions } from '../lib/admin'
import { sendPush } from './sendPush'

const db = admin.firestore()

// Cultures with these statuses are done/cancelled — skip them
const EXCLUDED_CULTURE_STATUSES = new Set(['termine', 'annule'])

// ─── types ───────────────────────────────────────────────────────────────────

export interface MorningPushDiagnostics {
  farmersFound: number          // farmer users checked for opt-out prefs
  farmersSkipped: number        // farmers with no eligible culture or opted out
  groupsFormed: number          // unique (commodity, province) pairs
  skippedGroups: Array<{
    crop: string
    province: string
    farmers: number
    reason: 'no_price_doc' | 'zero_price'
  }>
  pushAttempts: number          // total farmers for whom push was attempted
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function getUsdToCdf(): Promise<number> {
  try {
    const snap = await db.collection('config').doc('exchange_rate').get()
    return (snap.data()?.usdToCdf as number | undefined) ?? 2800
  } catch {
    return 2800
  }
}

function buildDeltaStr(current: number, previous: number | undefined): string {
  if (!previous || previous === 0) return ''
  const pct = Math.round(((current - previous) / previous) * 100)
  if (pct === 0) return ''
  return ` ${pct > 0 ? '↑' : '↓'}${Math.abs(pct)}%`
}

// ─── core logic (shared by scheduled CF and admin onCall CF) ─────────────────

export async function sendMorningPricePushCore(): Promise<MorningPushDiagnostics> {
  const diag: MorningPushDiagnostics = {
    farmersFound: 0,
    farmersSkipped: 0,
    groupsFormed: 0,
    skippedGroups: [],
    pushAttempts: 0,
  }

  // 1. Read farmer notification opt-outs from users collection
  const farmersSnap = await db.collection('users').where('role', '==', 'farmer').get()
  diag.farmersFound = farmersSnap.size

  if (farmersSnap.empty) {
    functions.logger.info('sendMorningPricePush: no farmer users found')
    return diag
  }

  const optedOutUids = new Set(
    farmersSnap.docs
      .filter(d => (d.data().notificationPrefs as Record<string, unknown> | undefined)?.morningPrice === false)
      .map(d => d.id)
  )

  // 2. Read all exploitations — commodity + province live here, not on the user doc
  const explSnap = await db.collection('exploitations').get()

  // groups: (commodity, province) → set of farmer UIDs
  const groups = new Map<string, { commodity: string; province: string; uids: Set<string> }>()
  const farmerHasGroup = new Set<string>()

  await Promise.all(explSnap.docs.map(async expl => {
    const e = expl.data()
    const farmerId: string = (e.farmerId as string | undefined) ?? ''
    const province: string = (e.province as string | undefined) ?? ''

    if (!farmerId || !province) return
    if (optedOutUids.has(farmerId)) return

    const cultSnap = await db.collection('exploitations').doc(expl.id)
      .collection('cultures')
      .get()

    for (const cult of cultSnap.docs) {
      const c = cult.data()
      const commodity: string = (c.commodity as string | undefined) ?? ''
      const status: string = (c.status as string | undefined) ?? 'active'

      if (!commodity || EXCLUDED_CULTURE_STATUSES.has(status)) continue

      const key = `${commodity}::${province}`
      if (!groups.has(key)) groups.set(key, { commodity, province, uids: new Set() })
      groups.get(key)!.uids.add(farmerId)
      farmerHasGroup.add(farmerId)
    }
  }))

  diag.farmersSkipped = farmersSnap.size - farmerHasGroup.size + optedOutUids.size
  diag.groupsFormed = groups.size

  if (groups.size === 0) {
    functions.logger.info('sendMorningPricePush: no (commodity, province) groups formed from exploitations')
    return diag
  }

  functions.logger.info(`sendMorningPricePush: ${groups.size} unique (commodity, province) pairs from ${farmerHasGroup.size} farmer(s)`)

  const usdToCdf = await getUsdToCdf()

  await Promise.all(
    [...groups.entries()].map(async ([, group]) => {
      const priceSnap = await db.collection('province_prices')
        .where('commodity', '==', group.commodity)
        .where('province', '==', group.province)
        .orderBy('updatedAt', 'desc')
        .limit(1)
        .get()

      if (priceSnap.empty) {
        functions.logger.warn(`sendMorningPricePush: no province_prices for ${group.commodity}/${group.province} — skipping ${group.uids.size} farmer(s)`)
        diag.skippedGroups.push({ crop: group.commodity, province: group.province, farmers: group.uids.size, reason: 'no_price_doc' })
        return
      }

      const priceData = priceSnap.docs[0].data()

      const pricePerKgCdf: number =
        (priceData.pricePerKgCdf as number | undefined) ??
        Math.round(((priceData.priceUsd as number | undefined) ?? 0) * usdToCdf)

      if (pricePerKgCdf === 0) {
        functions.logger.warn(`sendMorningPricePush: zero price for ${group.commodity}/${group.province} — skipping`)
        diag.skippedGroups.push({ crop: group.commodity, province: group.province, farmers: group.uids.size, reason: 'zero_price' })
        return
      }

      const previousPriceCdf = priceData.previousPricePerKgCdf as number | undefined
      const deltaStr = buildDeltaStr(pricePerKgCdf, previousPriceCdf)

      const title = 'Prix du marché ce matin'
      const body = `${group.commodity} à ${pricePerKgCdf.toLocaleString('fr-FR')} FC/kg en ${group.province}${deltaStr}`
      const data: Record<string, string> = {
        screen: 'market',
        crop: group.commodity,
        province: group.province,
      }

      functions.logger.info(`sendMorningPricePush: sending to ${group.uids.size} farmer(s) — ${body}`)
      diag.pushAttempts += group.uids.size

      await Promise.all(
        [...group.uids].map(uid =>
          Promise.all([
            sendPush(uid, title, body, data).catch(err =>
              functions.logger.warn(`sendMorningPricePush: sendPush failed for ${uid}`, err)
            ),
            db.collection('notifications').add({
              userId: uid,
              type: 'market_price',
              title,
              body,
              data,
              read: false,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            }).catch(err =>
              functions.logger.warn(`sendMorningPricePush: notification write failed for ${uid}`, err)
            ),
          ])
        )
      )
    })
  )

  return diag
}

// ─── scheduled CF ───────────────────────────────────────────────────────────

export const sendMorningPricePush = functions
  .region('europe-west1')
  .pubsub.schedule('30 6 * * *')
  .timeZone('Africa/Kinshasa')
  .onRun(() => sendMorningPricePushCore())
