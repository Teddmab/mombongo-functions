import * as crypto from 'crypto'
import axios from 'axios'
import { db } from '../lib/admin'
import { getUsdToCdf } from '../payments/initiateDeposit'

// PawaPay DRC correspondent codes — duplicated from initiateDeposit.ts's
// OPERATOR_MAP (not exported there); same 3-entry map, low churn.
const OPERATOR_MAP: Record<string, string> = {
  mpesa:  'VODACOM_MPESA_COD',
  airtel: 'AIRTEL_COD',
  orange: 'ORANGE_COD',
}

/**
 * Thrown when a testMode (sandbox) invoice's checkout is attempted but
 * PAWAPAY_API_KEY_SANDBOX isn't configured yet. Deliberately fails closed
 * rather than falling back to the production PawaPay key — a testMode
 * invoice (e.g. AROM's QA partner) must never be able to trigger a real
 * production mobile-money charge just because sandbox isn't set up yet.
 */
export class PawapaySandboxNotConfiguredError extends Error {
  constructor() {
    super('PawaPay sandbox is not configured (PAWAPAY_API_KEY_SANDBOX missing) — refusing to fall back to production for a testMode invoice.')
    this.name = 'PawapaySandboxNotConfiguredError'
  }
}

/**
 * Creates a PawaPay deposit for an external-invoice payment. Reuses
 * initiateDeposit.ts's PawaPay API-call shape, but does NOT write to the
 * deposits/{depositId} collection or require context.auth — the caller
 * is a signed partner request (SAI-01). PawaPay's deposits API has no
 * metadata pass-through, so there is nothing to tag the deposit with on
 * PawaPay's side — pawapayWebhook.ts's own branch identifies an
 * external-invoice-linked deposit by looking up external_invoices where
 * providerRef == depositId instead.
 */
export async function initiateExternalInvoiceMobileMoney(input: {
  amountUsd: number
  phone: string
  operator: string
  testMode: boolean
}): Promise<{ depositId: string; status: string }> {
  const correspondent = OPERATOR_MAP[input.operator]
  if (!correspondent) throw new Error(`Unknown operator: ${input.operator}`)
  if (!input.phone) throw new Error('phone required')

  // Routed per-invoice by testMode, not by a project-wide PAWAPAY_ENV var
  // — a single env var can't distinguish AROM's QA traffic from
  // production traffic hitting the same deployed functions. Fails closed
  // if sandbox is requested but not configured, rather than silently
  // charging through the production key.
  const apiKey = input.testMode ? process.env.PAWAPAY_API_KEY_SANDBOX : process.env.PAWAPAY_API_KEY
  if (input.testMode && !apiKey) throw new PawapaySandboxNotConfiguredError()
  const pawapayBase = input.testMode ? 'https://api.sandbox.pawapay.io' : 'https://api.pawapay.cloud'

  const depositId = crypto.randomUUID()
  const usdToCdf = await getUsdToCdf(db)
  const amountCdf = Math.round(input.amountUsd * usdToCdf)

  let response
  try {
    response = await axios.post(
      `${pawapayBase}/v1/deposits`,
      {
        depositId,
        amount: String(amountCdf),
        currency: 'CDF',
        correspondent,
        payer: { type: 'MSISDN', address: { value: input.phone.replace(/\D/g, '') } },
        customerTimestamp: new Date().toISOString(),
        statementDescription: 'Facture partenaire',
      },
      { headers: { Authorization: `Bearer ${apiKey}` } },
    )
  } catch (err: any) {
    const status = err?.response?.status
    if (status === 401) throw new Error('PawaPay API key invalide ou expiré.')
    throw new Error(`Erreur PawaPay (${status ?? 'réseau'}). Réessayez.`)
  }

  if (response.data.status !== 'ACCEPTED') {
    const code = response.data.rejectionReason?.rejectionCode ?? 'unknown'
    throw new Error(`PawaPay rejeté: ${code}`)
  }

  return { depositId, status: response.data.status }
}
