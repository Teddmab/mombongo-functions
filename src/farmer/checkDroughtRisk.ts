import { admin, functions } from '../lib/admin'
import { sendPush } from '../notifications/sendPush'
import { toDailySummaries, type HourlySlot } from '../lib/weatherUtils'

const db = admin.firestore()

type DroughtLevel = 'none' | 'watch' | 'warning' | 'critical'

function assessDrought(slots: HourlySlot[], currentTempC: number): { level: DroughtLevel; rainMm7d: number; message: string } {
  const dailies = toDailySummaries(slots).slice(0, 7)
  const rainMm7d = Math.round(dailies.reduce((sum, d) => sum + d.totalRainMm, 0) * 10) / 10
  const maxTemp7d = dailies.reduce((max, d) => Math.max(max, d.maxTempC), currentTempC)

  if (rainMm7d < 5 && maxTemp7d > 34) {
    return {
      level: 'critical',
      rainMm7d,
      message: `Risque de sécheresse critique — seulement ${rainMm7d}mm prévus sur 7 jours, températures > ${maxTemp7d}°C. Arrosez immédiatement si possible.`,
    }
  }
  if (rainMm7d < 10 && maxTemp7d > 30) {
    return {
      level: 'warning',
      rainMm7d,
      message: `Alerte sécheresse — ${rainMm7d}mm de pluie prévus cette semaine. Vos cultures peuvent souffrir. Économisez l'eau.`,
    }
  }
  if (rainMm7d < 20 && maxTemp7d > 28) {
    return {
      level: 'watch',
      rainMm7d,
      message: `Surveillance sécheresse — ${rainMm7d}mm de pluie prévus, chaleur à ${maxTemp7d}°C. Surveillez vos cultures.`,
    }
  }
  return { level: 'none', rainMm7d, message: '' }
}

// Runs daily at 8:00 AM WAT
export const checkDroughtRisk = functions
  .region('europe-west1')
  .pubsub.schedule('0 7 * * *')
  .timeZone('Africa/Kinshasa')
  .onRun(async () => {
    const weatherSnap = await db.collection('province_weather').get()

    // Build drought level per province
    const provinceDrought = new Map<string, { level: DroughtLevel; rainMm7d: number; message: string }>()
    for (const doc of weatherSnap.docs) {
      const { current, forecast } = doc.data() as { current?: { tempC: number }; forecast?: HourlySlot[] }
      const slots = forecast ?? []
      const currentTempC = current?.tempC ?? 28
      const result = assessDrought(slots, currentTempC)
      provinceDrought.set(doc.id, result)

      // Update exploitation records with drought alert level for display
      if (result.level !== 'none') {
        const explSnap = await db.collection('exploitations')
          .where('province', '==', doc.id)
          .get()
        const batch = db.batch()
        for (const expl of explSnap.docs) {
          batch.update(expl.ref, { droughtAlertLevel: result.level, droughtAlertUpdatedAt: admin.firestore.FieldValue.serverTimestamp() })
        }
        await batch.commit()
      }
    }

    // Get farmers with active cultures in drought-watch provinces
    const cultSnap = await db.collection('cultures').where('status', '==', 'active').get()
    const farmerProvince = new Map<string, string>()
    for (const doc of cultSnap.docs) {
      const { farmerId, exploitationId } = doc.data()
      if (!farmerId || farmerProvince.has(farmerId as string)) continue
      const explSnap = await db.collection('exploitations').doc(exploitationId as string).get()
      if (explSnap.exists) farmerProvince.set(farmerId as string, explSnap.data()!.province as string)
    }

    const tasks: Promise<unknown>[] = []
    for (const [farmerId, province] of farmerProvince) {
      const drought = provinceDrought.get(province)
      if (!drought || drought.level === 'none') continue

      const emoji = drought.level === 'critical' ? '🔴' : drought.level === 'warning' ? '🟠' : '🟡'
      tasks.push(
        sendPush(
          farmerId,
          `${emoji} Alerte sécheresse`,
          drought.message,
          { type: 'drought_risk', province, level: drought.level }
        ).catch(() => undefined)
      )
    }

    await Promise.all(tasks)
    functions.logger.info(`checkDroughtRisk: ${tasks.length} drought alerts sent`)
    return null
  })
