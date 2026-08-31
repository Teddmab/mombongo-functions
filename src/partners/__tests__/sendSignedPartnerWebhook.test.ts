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
