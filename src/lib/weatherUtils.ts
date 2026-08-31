export interface HourlySlot {
  dtUnix: number
  tempC: number
  humidity: number
  rain3hMm: number
  conditionMain: string
  windKmh: number
  pop: number  // probability of precipitation 0–1
}

export interface DailySummary {
  dateStr: string        // 'YYYY-MM-DD'
  maxTempC: number
  minTempC: number
  totalRainMm: number
  maxWindKmh: number
  dominantCondition: string
  maxPop: number
  isFarmingDay: boolean  // dry + not too hot + not stormy + wind ok
}

// Condition severity for dominant-condition selection (worst wins)
const CONDITION_RANK = [
  'Thunderstorm', 'Squall', 'Tornado',
  'Rain', 'Drizzle', 'Snow',
  'Clouds', 'Mist', 'Fog',
  'Clear',
]

export function toDailySummaries(slots: HourlySlot[]): DailySummary[] {
  const dayMap = new Map<string, HourlySlot[]>()
  for (const slot of slots) {
    // Use WAT (UTC+1) date
    const dateStr = new Date((slot.dtUnix + 3600) * 1000).toISOString().split('T')[0]
    if (!dayMap.has(dateStr)) dayMap.set(dateStr, [])
    dayMap.get(dateStr)!.push(slot)
  }

  const result: DailySummary[] = []
  for (const [dateStr, daySlots] of dayMap) {
    const temps = daySlots.map(s => s.tempC)
    const totalRainMm = Math.round(daySlots.reduce((sum, s) => sum + s.rain3hMm, 0) * 10) / 10
    const maxWindKmh = Math.round(Math.max(...daySlots.map(s => s.windKmh)))
    const maxPop = Math.max(...daySlots.map(s => s.pop))

    let dominantCondition = 'Clear'
    for (const rank of CONDITION_RANK) {
      if (daySlots.some(s => s.conditionMain === rank)) { dominantCondition = rank; break }
    }

    const maxTemp = Math.round(Math.max(...temps))
    const isFarmingDay =
      totalRainMm < 8 &&
      maxTemp < 35 &&
      maxTemp > 13 &&
      maxWindKmh < 35 &&
      dominantCondition !== 'Thunderstorm' &&
      dominantCondition !== 'Squall'

    result.push({
      dateStr,
      maxTempC: maxTemp,
      minTempC: Math.round(Math.min(...temps)),
      totalRainMm,
      maxWindKmh,
      dominantCondition,
      maxPop,
      isFarmingDay,
    })
  }

  return result.sort((a, b) => a.dateStr.localeCompare(b.dateStr))
}

export function conditionEmoji(condition: string): string {
  const map: Record<string, string> = {
    Thunderstorm: '⛈️', Squall: '🌬️', Tornado: '🌪️',
    Rain: '🌧️', Drizzle: '🌦️', Snow: '❄️',
    Clouds: '⛅', Mist: '🌫️', Fog: '🌫️', Haze: '🌫️',
    Clear: '☀️',
  }
  return map[condition] ?? '🌤️'
}
