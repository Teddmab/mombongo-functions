import { admin, functions } from '../lib/admin'
import { sendPush } from '../notifications/sendPush'
import { toDailySummaries, type HourlySlot } from '../lib/weatherUtils'

const db = admin.firestore()

// Spray is safe when: wind < 15 km/h, no rain in next 4 hours, temp 18–32°C, not thunderstorm
function isSpraySafe(slots: HourlySlot[]): { safe: boolean; hoursWindow: number; reason: string } {
  const nextSlots = slots.slice(0, 4) // next 12 hours (3h × 4)
  if (nextSlots.length === 0) return { safe: false, hoursWindow: 0, reason: 'Données météo insuffisantes' }

  const hasThunderstorm = nextSlots.some(s => s.conditionMain === 'Thunderstorm')
  const hasRain = nextSlots.some(s => s.rain3hMm > 1 || s.pop > 0.4)
  const highWind = nextSlots.some(s => s.windKmh > 15)
  const badTemp = nextSlots.some(s => s.tempC > 32 || s.tempC < 15)

  if (hasThunderstorm) return { safe: false, hoursWindow: 0, reason: 'Orage prévu' }
  if (hasRain)         return { safe: false, hoursWindow: 0, reason: 'Pluie attendue' }
  if (highWind)        return { safe: false, hoursWindow: 0, reason: 'Vent trop fort' }
  if (badTemp)         return { safe: false, hoursWindow: 0, reason: 'Température défavorable' }

  // Count consecutive safe hours
  let safeSlots = 0
  for (const slot of nextSlots) {
    if (slot.rain3hMm < 1 && slot.pop < 0.3 && slot.windKmh < 15) safeSlots++
    else break
  }

  return { safe: true, hoursWindow: safeSlots * 3, reason: '' }
}

// Runs at 6:00 AM and 1:00 PM WAT
export const checkSprayConditions = functions
  .region('europe-west1')
  .pubsub.schedule('0 5,12 * * *')
  .timeZone('Africa/Kinshasa')
  .onRun(async () => {
    // Get all provinces with cached weather
    const weatherSnap = await db.collection('province_weather').get()
    const sprayProvinces = new Set<string>()

    for (const doc of weatherSnap.docs) {
      const slots = (doc.data().forecast as HourlySlot[] | undefined) ?? []
      const { safe } = isSpraySafe(slots)
      if (safe) sprayProvinces.add(doc.id)
    }

    if (sprayProvinces.size === 0) return null

    // Find farmers in spray-safe provinces with active cultures
    const cultSnap = await db.collection('cultures').where('status', '==', 'active').get()
    const farmerProvinces = new Map<string, string>() // farmerId → province

    for (const doc of cultSnap.docs) {
      const { farmerId, exploitationId } = doc.data()
      if (!farmerId || farmerProvinces.has(farmerId)) continue
      const explSnap = await db.collection('exploitations').doc(exploitationId as string).get()
      if (explSnap.exists) farmerProvinces.set(farmerId as string, explSnap.data()!.province as string)
    }

    const tasks: Promise<unknown>[] = []
    for (const [farmerId, province] of farmerProvinces) {
      if (!sprayProvinces.has(province)) continue
      const cached = weatherSnap.docs.find(d => d.id === province)
      if (!cached) continue
      const slots = (cached.data().forecast as HourlySlot[]) ?? []
      const { hoursWindow } = isSpraySafe(slots)

      tasks.push(
        sendPush(
          farmerId,
          '🌿 Fenêtre de traitement ouverte',
          `Conditions idéales pour pulvériser vos cultures — vent calme, pas de pluie prévue pendant ${hoursWindow}h. Agissez avant la fin de la fenêtre.`,
          { type: 'spray_window', province }
        ).catch(() => undefined)
      )
    }

    await Promise.all(tasks)
    functions.logger.info(`checkSprayConditions: sent ${tasks.length} spray alerts`)
    return null
  })
