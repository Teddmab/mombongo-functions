import { db, functions } from '../lib/admin'
import { getUsdToCdf } from '../payments/initiateDeposit'

/**
 * Reuses getUsdToCdf (config/exchange_rate.usdToCdf) — the same source
 * every payment function reads. Previously read a separate, never-written
 * doc (config/exchangeRate.rate), so the rate the frontend displayed could
 * silently diverge from the rate actually used to charge a payment.
 */
export const getExchangeRate = functions
  .region('europe-west1')
  .https.onCall(async (_data, _context) => {
    const rate = await getUsdToCdf(db)
    return { rate, updatedAt: new Date().toISOString() }
  })
