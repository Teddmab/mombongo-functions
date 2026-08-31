import axios from 'axios'
import { admin, functions } from '../lib/admin'

const db = admin.firestore()

// Free, no-API-key tier of exchangerate-api.com — updates once daily.
// No secret to provision, unlike refreshProvinceWeather's OpenWeather key.
const RATE_API_URL = 'https://open.er-api.com/v6/latest/USD'

interface OpenErApiResponse {
  result: string
  rates: Record<string, number>
}

export async function fetchUsdToCdfFromApi(): Promise<number> {
  const res = await axios.get<OpenErApiResponse>(RATE_API_URL, { timeout: 8000 })
  if (res.data.result !== 'success') {
    throw new Error(`open.er-api.com returned result=${res.data.result}`)
  }
  const rate = res.data.rates?.CDF
  if (typeof rate !== 'number' || rate <= 0) {
    throw new Error(`open.er-api.com response missing a valid CDF rate (got ${rate})`)
  }
  return rate
}

export async function refreshExchangeRateCore(): Promise<number> {
  const rate = await fetchUsdToCdfFromApi()
  await db.collection('config').doc('exchange_rate').set(
    {
      usdToCdf: rate,
      source: 'open.er-api.com',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  )
  return rate
}

// Runs every 6 hours — the source itself only updates once a day, but
// checking more often means a source-side delay doesn't compound with
// ours. getUsdToCdf (initiateDeposit.ts) still falls back to 2800 if this
// has never run or Firestore is unreachable.
export const refreshExchangeRate = functions
  .region('europe-west1')
  .pubsub.schedule('0 */6 * * *')
  .timeZone('Africa/Kinshasa')
  .onRun(async () => {
    try {
      const rate = await refreshExchangeRateCore()
      functions.logger.info(`refreshExchangeRate: usdToCdf updated to ${rate}`)
    } catch (err) {
      functions.logger.error('refreshExchangeRate: failed to update usdToCdf', err)
    }
    return null
  })
