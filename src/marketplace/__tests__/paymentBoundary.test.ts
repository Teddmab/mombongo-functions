import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Section F (payment boundary) — approved business decision: an accepted
 * offer / issued invoice must NOT trigger payment automatically. AROM
 * must call createExternalInvoiceCheckout itself, deliberately, only
 * after physical reception + quality/quantity approval (a future
 * contract not built in this change — see the audit report).
 *
 * This is a structural regression guard, not a mock-based behavioral
 * test: it checks actual import statements in the offer-acceptance code
 * path for any checkout/payment-initiation module — a stronger guarantee
 * against "someone quietly wires this up later without noticing the
 * business rule" than mocking the checkout function and asserting it
 * wasn't called, which only proves today's exact runtime behavior.
 */
describe('payment boundary — offer acceptance must never auto-trigger checkout', () => {
  const FORBIDDEN_MODULES = [
    'createCheckoutForInvoiceCore',
    'createExternalInvoiceCheckout',
    'payHarvestInvoice',
    'initiateExternalInvoiceMobileMoney',
  ]

  // Checks import statements only, not every substring occurrence — a doc
  // comment explaining *why* this boundary matters is allowed to name the
  // checkout function in prose; an import of it is not.
  function assertNoImportOf(filePath: string, modules: string[]) {
    const source = fs.readFileSync(filePath, 'utf8')
    const importLines = source.split('\n').filter((line) => /^\s*import\b/.test(line))
    for (const forbidden of modules) {
      expect(importLines.some((line) => line.includes(forbidden))).toBe(false)
    }
  }

  it('selectHarvestOffer.ts does not import any checkout/payment-initiation module', () => {
    assertNoImportOf(path.join(__dirname, '../selectHarvestOffer.ts'), FORBIDDEN_MODULES)
  })

  it('notifyPartnerInvoiceIssued.ts (the invoice_issued webhook sender) does not import any checkout/payment-initiation module', () => {
    assertNoImportOf(path.join(__dirname, '../../partners/notifyPartnerInvoiceIssued.ts'), FORBIDDEN_MODULES)
  })

  it('notifyPartnerOfferStatusChanged.ts (the accepted/declined webhook sender) does not import any checkout/payment-initiation module', () => {
    assertNoImportOf(path.join(__dirname, '../../partners/notifyPartnerOfferStatusChanged.ts'), FORBIDDEN_MODULES)
  })
})
