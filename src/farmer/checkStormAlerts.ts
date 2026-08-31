import { admin, functions } from '../lib/admin'
import { sendPush } from '../notifications/sendPush'
import { type HourlySlot } from '../lib/weatherUtils'

const db = admin.firestore()

interface StormThreat {
  severity: 'warning' | 'watch'
  hoursUntil: number
  description: string
}

function detectStorm(slots: HourlySlot[]): StormThreat | null {
  const next8 = slots.slice(0, 8) // next 24h (3h × 8)

  for (let i = 0; i < next8.length; i++) {
    const slot = next8[i]
    const hoursUntil = i * 3

    if (slot.conditionMain === 'Thunderstorm') {
      return {
        severity: 'warning',
        hoursUntil,
        description: `Orage prévu dans ${hoursUntil === 0 ? 'moins d\'une heure' : `${hoursUntil}h`}. Rentrez vos outils, sécurisez votre matériel.`,
      }
    }
    if (slot.windKmh > 45) {
      return {
        severity: 'warning',
        hoursUntil,
        description: `Vents violents (${slot.windKmh}km/h) prévus dans ${hoursUntil === 0 ? 'moins d\'une heure' : `${hoursUntil}h`}. Sécurisez serres et équipements.`,
      }
    }
    if (slot.windKmh > 30 || slot.pop > 0.75) {
      return {
        severity: 'watch',
        hoursUntil,
        description: `Conditions orageuses possibles dans ${hoursUntil === 0 ? 'moins d\'une heure' : `${hoursUntil}h`} — vents à ${slot.windKmh}km/h, forte probabilité de pluie.`,
      }
    }
  }

  return null
}

// Runs every 3 hours — same cadence as weather refresh
export const checkStormAlerts = functions
  .region('europe-west1')
  .pubsub.schedule('30 */3 * * *') // offset 30 min after refreshProvinceWeather
  .timeZone('Africa/Kinshasa')
  .onRun(async () => {
    const weatherSnap = await db.collection('province_weather').get()

    const stormProvinces = new Map<string, StormThreat>()
    for (const doc of weatherSnap.docs) {
      const slots = (doc.data().forecast as HourlySlot[] | undefined) ?? []
      const threat = detectStorm(slots)
      if (threat) stormProvinces.set(doc.id, threat)
    }

    if (stormProvinces.size === 0) return null

    // Get all active farmers in storm provinces
    const explSnap = await db.collection('exploitations')
      .where('province', 'in', Array.from(stormProvinces.keys()).slice(0, 10)) // Firestore 'in' limit
      .get()

    const tasks: Promise<unknown>[] = []
    for (const expl of explSnap.docs) {
      const { farmerId, province } = expl.data()
      if (!farmerId || !province) continue
      const threat = stormProvinces.get(province as string)
      if (!threat) continue

      const emoji = threat.severity === 'warning' ? '⛈️' : '🌩️'
      tasks.push(
        sendPush(
          farmerId as string,
          `${emoji} Alerte météo`,
          threat.description,
          { type: 'storm_alert', province, severity: threat.severity }
        ).catch(() => undefined)
      )
    }

    await Promise.all(tasks)
    functions.logger.info(`checkStormAlerts: ${tasks.length} storm alerts sent`)
    return null
  })
