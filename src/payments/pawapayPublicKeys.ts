import axios from 'axios'

const PAWAPAY_BASE = process.env.PAWAPAY_ENV === 'sandbox'
  ? 'https://api.sandbox.pawapay.io'
  : 'https://api.pawapay.cloud'

interface PawapayPublicKey {
  id: string
  key: string // PEM-encoded public key
}

/**
 * In-memory cache of PawaPay's callback-signing public keys (GET
 * /public-key/http — public, unauthenticated). Module-level so it survives
 * warm invocations of the same function instance; a cold start just
 * refetches, which is fine for a fast HTTPS GET to a static-ish endpoint.
 *
 * Key rotation: getPawapayPublicKey refetches automatically whenever the
 * requested keyid isn't in the current cache, even before the TTL expires
 * — handles PawaPay rotating keys between our TTL refreshes without a
 * caller needing to retry. `force` exists only for callers with their own
 * reason to bypass a fresh cache (none currently do).
 */
let cache: { keys: Map<string, PawapayPublicKey>; fetchedAt: number } | null = null
const TTL_MS = 10 * 60 * 1000

async function fetchKeys(): Promise<Map<string, PawapayPublicKey>> {
  const { data } = await axios.get<PawapayPublicKey[]>(`${PAWAPAY_BASE}/public-key/http`, { timeout: 5000 })
  const map = new Map<string, PawapayPublicKey>()
  for (const k of data) {
    if (k?.id && k?.key) map.set(k.id, k)
  }
  return map
}

/**
 * Resolves a callback's `keyid` (from its Signature-Input header) to a PEM
 * public key. Returns null — never throws — on any failure (network error,
 * unknown keyid, malformed response), so callers can fail closed uniformly
 * alongside every other verification failure.
 */
export async function getPawapayPublicKey(keyid: string, force = false): Promise<string | null> {
  const current = cache
  const needsFetch = force || !current || Date.now() - current.fetchedAt > TTL_MS || !current.keys.has(keyid)

  if (needsFetch) {
    try {
      cache = { keys: await fetchKeys(), fetchedAt: Date.now() }
    } catch {
      // Keep serving the previous cache (if any) rather than hard-failing
      // every webhook on a transient network blip against PawaPay's key
      // endpoint — but if there was never a successful fetch, there's
      // nothing to fall back to.
      cache = current
    }
  }
  return cache?.keys.get(keyid)?.key ?? null
}

/** Test-only: reset the module-level cache between test cases. */
export function _resetPawapayPublicKeyCacheForTests(): void {
  cache = null
}
