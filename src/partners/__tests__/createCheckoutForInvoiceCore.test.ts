import { describe, it, expect, vi, beforeEach } from 'vitest'

const updateMock = vi.fn()
const invoiceRef = { update: updateMock } as unknown as FirebaseFirestore.DocumentReference

vi.mock('../../lib/admin', () => ({
  functions: { logger: { error: vi.fn() } },
}))

const { initiateCardMock, initiateMobileMoneyMock } = vi.hoisted(() => ({
  initiateCardMock: vi.fn(),
  initiateMobileMoneyMock: vi.fn(),
}))
vi.mock('../initiateExternalInvoiceCard', () => ({ initiateExternalInvoiceCard: initiateCardMock }))
vi.mock('../initiateExternalInvoiceMobileMoney', () => ({ initiateExternalInvoiceMobileMoney: initiateMobileMoneyMock }))

import { createCheckoutForInvoiceCore } from '../createCheckoutForInvoiceCore'

describe('createCheckoutForInvoiceCore', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates a card checkout and writes merchantUid + status onto the invoice', async () => {
    initiateCardMock.mockResolvedValueOnce({ paymentIntentId: 'pi_1', clientSecret: 'secret_1' })
    const result = await createCheckoutForInvoiceCore({
      invoiceRef, invoiceId: 'inv1', amountUsd: 50, merchantUid: 'm1', partnerId: null, method: 'card',
    })
    expect(result).toEqual({ ok: true, providerRef: 'pi_1', responseBody: { clientSecret: 'secret_1' } })
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'checkout_created', providerRef: 'pi_1', merchantUid: 'm1' }),
    )
  })

  it('passes partnerId through to the card initiator', async () => {
    initiateCardMock.mockResolvedValueOnce({ paymentIntentId: 'pi_1', clientSecret: null })
    await createCheckoutForInvoiceCore({
      invoiceRef, invoiceId: 'inv1', amountUsd: 50, merchantUid: 'm1', partnerId: 'arom', method: 'card',
    })
    expect(initiateCardMock).toHaveBeenCalledWith(expect.objectContaining({ partnerId: 'arom' }))
  })

  it('creates a mobile_money checkout when phone/operator are present', async () => {
    initiateMobileMoneyMock.mockResolvedValueOnce({ depositId: 'dep1', status: 'ACCEPTED' })
    const result = await createCheckoutForInvoiceCore({
      invoiceRef, invoiceId: 'inv1', amountUsd: 50, merchantUid: 'm1', partnerId: null,
      method: 'mobile_money', phone: '+243900000000', operator: 'mpesa',
    })
    expect(result).toEqual({ ok: true, providerRef: 'dep1', responseBody: { depositStatus: 'ACCEPTED' } })
  })

  it('rejects mobile_money without phone/operator, without calling the provider', async () => {
    const result = await createCheckoutForInvoiceCore({
      invoiceRef, invoiceId: 'inv1', amountUsd: 50, merchantUid: 'm1', partnerId: null, method: 'mobile_money',
    })
    expect(result).toEqual({ ok: false, kind: 'missing_phone_operator' })
    expect(initiateMobileMoneyMock).not.toHaveBeenCalled()
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('rejects bank_transfer as not yet implemented', async () => {
    const result = await createCheckoutForInvoiceCore({
      invoiceRef, invoiceId: 'inv1', amountUsd: 50, merchantUid: 'm1', partnerId: null, method: 'bank_transfer',
    })
    expect(result).toEqual({ ok: false, kind: 'bank_transfer_unimplemented' })
  })

  it('surfaces a provider error without writing to the invoice', async () => {
    initiateCardMock.mockRejectedValueOnce(new Error('Stripe down'))
    const result = await createCheckoutForInvoiceCore({
      invoiceRef, invoiceId: 'inv1', amountUsd: 50, merchantUid: 'm1', partnerId: null, method: 'card',
    })
    expect(result).toEqual({ ok: false, kind: 'provider_error', message: 'Stripe down' })
    expect(updateMock).not.toHaveBeenCalled()
  })
})
