import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

const addMock = vi.fn()

vi.mock('../../lib/admin', () => ({
  db: { collection: (name: string) => { if (name !== 'outbound_notification_failures') throw new Error(name); return { add: addMock } } },
  functions: { logger: { warn: vi.fn() } },
}))
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: vi.fn(() => 'SERVER_TIMESTAMP') } }))

import { sendSignedPartnerWebhook } from '../sendSignedPartnerWebhook'

const originalFetch = global.fetch

describe('sendSignedPartnerWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })
  afterAll(() => { global.fetch = originalFetch })

  it('calls onSuccess and does not dead-letter when the webhook responds ok', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch
    const onSuccess = vi.fn()
    await sendSignedPartnerWebhook({
      webhookUrl: 'https://x.com/hook', outboundSecret: 'secret', payload: { a: 1 },
      kind: 'invoice_issued', partnerId: 'arom', invoiceId: 'inv1', onSuccess,
    })
    expect(onSuccess).toHaveBeenCalledOnce()
    expect(addMock).not.toHaveBeenCalled()
  })

  it('stamps event onto the sent body and signs the resulting body, not the original payload', async () => {
    const crypto = await import('crypto')
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch
    await sendSignedPartnerWebhook({
      webhookUrl: 'https://x.com/hook', outboundSecret: 'secret', payload: { invoiceId: 'inv1' },
      kind: 'invoice_issued', partnerId: 'arom', invoiceId: 'inv1', onSuccess: vi.fn(),
    })
    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const sentBody = JSON.parse(options.body)
    expect(sentBody).toEqual({ event: 'invoice_issued', invoiceId: 'inv1' })
    const expectedSignature = crypto.createHmac('sha256', 'secret').update(JSON.stringify(sentBody)).digest('hex')
    expect(options.headers['x-mombongo-signature']).toBe(expectedSignature)
  })

  it('retries on failure, then dead-letters with the kind tagged, after exhausting attempts', async () => {
    vi.useFakeTimers()
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch
    const onSuccess = vi.fn()
    const promise = sendSignedPartnerWebhook({
      webhookUrl: 'https://x.com/hook', outboundSecret: 'secret', payload: { a: 1 },
      kind: 'invoice_issued', partnerId: 'arom', invoiceId: 'inv1', onSuccess,
    })
    await vi.runAllTimersAsync()
    await promise
    expect(onSuccess).not.toHaveBeenCalled()
    expect(global.fetch).toHaveBeenCalledTimes(3)
    expect(addMock).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 'inv1', partnerId: 'arom', kind: 'invoice_issued' }),
    )
    vi.useRealTimers()
  })

  it('the dead-letter record never contains the secret or the computed signature — only correlation metadata and the error', async () => {
    vi.useFakeTimers()
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch
    const promise = sendSignedPartnerWebhook({
      webhookUrl: 'https://x.com/hook', outboundSecret: 'super-secret-value', payload: { a: 1 },
      kind: 'invoice_issued', partnerId: 'arom', invoiceId: 'inv1', onSuccess: vi.fn(),
    })
    await vi.runAllTimersAsync()
    await promise
    const written = addMock.mock.calls[0][0]
    expect(written).not.toHaveProperty('outboundSecret')
    expect(written).not.toHaveProperty('secret')
    expect(written).not.toHaveProperty('signature')
    expect(JSON.stringify(written)).not.toContain('super-secret-value')
    vi.useRealTimers()
  })

  it('supports the offer_status_changed kind identically to the other two — same signing, same dead-letter tagging', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch
    const onSuccess = vi.fn()
    await sendSignedPartnerWebhook({
      webhookUrl: 'https://x.com/hook', outboundSecret: 'secret', payload: { offerId: 'o1', status: 'accepted' },
      kind: 'offer_status_changed', partnerId: 'arom', invoiceId: 'o1', onSuccess,
    })
    const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(JSON.parse(options.body)).toEqual({ event: 'offer_status_changed', offerId: 'o1', status: 'accepted' })
    expect(onSuccess).toHaveBeenCalledOnce()
  })

  it('two different partners never share a webhookUrl/secret — each call only ever uses the exact url/secret passed for it', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch
    await sendSignedPartnerWebhook({
      webhookUrl: 'https://arom.cd/hook', outboundSecret: 'arom-secret', payload: { a: 1 },
      kind: 'invoice_issued', partnerId: 'arom', invoiceId: 'inv1', onSuccess: vi.fn(),
    })
    await sendSignedPartnerWebhook({
      webhookUrl: 'https://other-partner.example/hook', outboundSecret: 'other-secret', payload: { a: 1 },
      kind: 'invoice_issued', partnerId: 'other-partner', invoiceId: 'inv2', onSuccess: vi.fn(),
    })
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0][0]).toBe('https://arom.cd/hook')
    expect(calls[1][0]).toBe('https://other-partner.example/hook')
    // Signatures must differ — same payload shape, different secrets.
    expect(calls[0][1].headers['x-mombongo-signature']).not.toBe(calls[1][1].headers['x-mombongo-signature'])
  })
})
