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
})
