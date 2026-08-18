import { admin, functions } from '../lib/admin'
import { sendPush } from './sendPush'

const db = admin.firestore()

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

export async function sendMorningPricePushCore(): Promise<void> {
  const farmersSnap = await db.collection('users')
    .where('role', '==', 'farmer')
    .get()

  if (farmersSnap.empty) {
    functions.logger.info('sendMorningPricePush: no farmers found')
    return
  }

  const groups = new Map<string, { crop: string; province: string; uids: string[] }>()

  for (const doc of farmersSnap.docs) {
    const d = doc.data()
    const crop: string = (d.cropType as string | undefined) ?? ''
    const province: string = (d.province as string | undefined) ?? ''
    if (!crop || !province) continue
    if ((d.notificationPrefs as Record<string, unknown> | undefined)?.morningPrice === false) continue

    const key = `${crop}::${province}`
    if (!groups.has(key)) groups.set(key, { crop, province, uids: [] })
    groups.get(key)!.uids.push(doc.id)
  }

  if (groups.size === 0) {
    functions.logger.info('sendMorningPricePush: no eligible farmers with crop+province set')
    return
  }

  functions.logger.info(`sendMorningPricePush: ${farmersSnap.size} farmers, ${groups.size} unique (crop, province) pairs`)

  const usdToCdf = await getUsdToCdf()

  await Promise.all(
    [...groups.entries()].map(async ([, group]) => {
      const priceSnap = await db.collection('province_prices')
        .where('commodity', '==', group.crop)
        .where('province', '==', group.province)
        .orderBy('updatedAt', 'desc')
        .limit(1)
        .get()

      if (priceSnap.empty) {
        functions.logger.warn(`sendMorningPricePush: no province_prices for ${group.crop}/${group.province} — skipping ${group.uids.length} farmer(s)`)
        return
      }

      const priceData = priceSnap.docs[0].data()

      const pricePerKgCdf: number =
        (priceData.pricePerKgCdf as number | undefined) ??
        Math.round(((priceData.priceUsd as number | undefined) ?? 0) * usdToCdf)

      if (pricePerKgCdf === 0) {
        functions.logger.warn(`sendMorningPricePush: zero price for ${group.crop}/${group.province} — skipping`)
        return
      }

      const previousPriceCdf = priceData.previousPricePerKgCdf as number | undefined
      const deltaStr = buildDeltaStr(pricePerKgCdf, previousPriceCdf)

      const title = 'Prix du marché ce matin'
      const body = `${group.crop} à ${pricePerKgCdf.toLocaleString('fr-FR')} FC/kg en ${group.province}${deltaStr}`
      const data: Record<string, string> = {
        screen: 'market',
        crop: group.crop,
        province: group.province,
      }

      functions.logger.info(`sendMorningPricePush: sending to ${group.uids.length} farmers — ${body}`)

      await Promise.all(
        group.uids.map(uid =>
          sendPush(uid, title, body, data).catch(err =>
            functions.logger.warn(`sendMorningPricePush: sendPush failed for ${uid}`, err)
          )
        )
      )
    })
  )
}

// ─── scheduled CF ───────────────────────────────────────────────────────────

export const sendMorningPricePush = functions
  .region('europe-west1')
  .pubsub.schedule('30 6 * * *')
  .timeZone('Africa/Kinshasa')
  .onRun(() => sendMorningPricePushCore())
