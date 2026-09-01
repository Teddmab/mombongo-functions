/**
 * Best-effort extraction of an operator fee from a PawaPay webhook body.
 * No prior code in this repo ever read a fee field from PawaPay, so the
 * exact field name/path isn't confirmed against their real API — this
 * checks a few plausible shapes (top-level `fee`, nested under
 * `amountDetails`) rather than assuming one. Returns null when nothing
 * matches, which callers must treat as "not communicated," never as zero.
 */
export function extractPawapayFee(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>

  const direct = b.fee ?? b.chargeFee ?? b.charges
  if (typeof direct === 'number') return direct
  if (typeof direct === 'string' && direct.trim() !== '' && !Number.isNaN(Number(direct))) return Number(direct)

  const amountDetails = b.amountDetails
  if (amountDetails && typeof amountDetails === 'object') {
    const nested = (amountDetails as Record<string, unknown>).fee
    if (typeof nested === 'number') return nested
    if (typeof nested === 'string' && nested.trim() !== '' && !Number.isNaN(Number(nested))) return Number(nested)
  }

  return null
}
