import { describe, it, expect, vi, beforeEach } from 'vitest'

const offerUpdateMock = vi.fn()
const offers: Record<string, Record<string, unknown> | undefined> = {}
const partners: Record<string, Record<string, unknown> | undefined> = {}

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => {
      const store = { harvest_offers: offers, partners }[name]
      if (!store) throw new Error(`unexpected collection ${name}`)
      return {
        doc: (id: string) => ({
          get: async () => ({ exists: store[id] !== undefined, data: () => store[id], ref: { update: offerUpdateMock } }),
        }),
      }
    },
  },
  functions: { logger: { error: vi.fn() } },
}))
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: vi.fn(() => 'SERVER_TIMESTAMP') } }))

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }))
vi.mock('../sendSignedPartnerWebhook', () => ({ sendSignedPartnerWebhook: sendMock }))

import { notifyPartnerOfferStatusChanged } from '../notifyPartnerOfferStatusChanged'
import { computeEventId } from '../../lib/eventId'

describe('notifyPartnerOfferStatusChanged', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const s of [offers, partners]) for (const k of Object.keys(s)) delete s[k]
  })

  it('does nothing when the offer does not exist', async () => {
    await notifyPartnerOfferStatusChanged('nope', 'accepted')
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('does nothing for an in-app offer (no partnerId)', async () => {
    offers['o1'] = { partnerId: null, listingId: 'l1', offerQuantityKg: 10, offerPricePerKgCdf: 500 }
    await notifyPartnerOfferStatusChanged('o1', 'accepted')
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('does nothing when the partner has no webhookUrl/outboundHmacSecret', async () => {
    offers['o1'] = { partnerId: 'arom', listingId: 'l1', offerQuantityKg: 10, offerPricePerKgCdf: 500 }
    partners['arom'] = { name: 'AROM' }
    await notifyPartnerOfferStatusChanged('o1', 'accepted')
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('sends an accepted event with the exact documented fields', async () => {
    offers['o1'] = {
      partnerId: 'arom', listingId: 'l1', offerQuantityKg: 50, offerPricePerKgCdf: 800,
      externalReference: 'arom-po-1',
    }
    partners['arom'] = { webhookUrl: 'https://arom.cd/hook', outboundHmacSecret: 'secret' }
    await notifyPartnerOfferStatusChanged('o1', 'accepted')

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookUrl: 'https://arom.cd/hook',
        outboundSecret: 'secret',
        kind: 'offer_status_changed',
        partnerId: 'arom',
        invoiceId: 'o1', // reused slot for offerId, see sendSignedPartnerWebhook.ts
        payload: expect.objectContaining({
          schemaVersion: 1,
          partnerId: 'arom',
          offerId: 'o1',
          externalReference: 'arom-po-1',
          listingId: 'l1',
          status: 'accepted',
          quantityKg: 50,
          unitPriceCdf: 800,
          currency: 'CDF',
        }),
      }),
    )
    const payload = sendMock.mock.calls[0][0].payload
    expect(typeof payload.eventId).toBe('string')
    expect(typeof payload.occurredAt).toBe('string')
  })

  it('sends a declined event for a losing offer, with externalReference null when absent', async () => {
    offers['o2'] = { partnerId: 'arom', listingId: 'l1', offerQuantityKg: 20, offerPricePerKgCdf: 700 }
    partners['arom'] = { webhookUrl: 'https://arom.cd/hook', outboundHmacSecret: 'secret' }
    await notifyPartnerOfferStatusChanged('o2', 'declined')

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ status: 'declined', externalReference: null }),
      }),
    )
  })

  it('eventId is stable/deterministic — the same offerId+status always produces the same eventId, so retries reuse it', async () => {
    offers['o1'] = { partnerId: 'arom', listingId: 'l1', offerQuantityKg: 50, offerPricePerKgCdf: 800 }
    partners['arom'] = { webhookUrl: 'https://arom.cd/hook', outboundHmacSecret: 'secret' }

    await notifyPartnerOfferStatusChanged('o1', 'accepted')
    const firstEventId = sendMock.mock.calls[0][0].payload.eventId

    sendMock.mockClear()
    await notifyPartnerOfferStatusChanged('o1', 'accepted')
    const secondEventId = sendMock.mock.calls[0][0].payload.eventId

    expect(secondEventId).toBe(firstEventId)
    expect(firstEventId).toBe(computeEventId('offer_status_changed', 'o1', 'accepted'))
  })

  it('accepted and declined for the SAME offer id would produce different eventIds (never actually both fire for one offer, but the id space must not collide)', () => {
    expect(computeEventId('offer_status_changed', 'o1', 'accepted'))
      .not.toBe(computeEventId('offer_status_changed', 'o1', 'declined'))
  })

  it('resolves the webhookUrl/secret from the offer\'s OWN partnerId — never another partner\'s config', async () => {
    offers['o-arom'] = { partnerId: 'arom', listingId: 'l1', offerQuantityKg: 10, offerPricePerKgCdf: 100 }
    offers['o-other'] = { partnerId: 'other-partner', listingId: 'l2', offerQuantityKg: 20, offerPricePerKgCdf: 200 }
    partners['arom'] = { webhookUrl: 'https://arom.cd/hook', outboundHmacSecret: 'arom-secret' }
    partners['other-partner'] = { webhookUrl: 'https://other.example/hook', outboundHmacSecret: 'other-secret' }

    await notifyPartnerOfferStatusChanged('o-arom', 'accepted')
    expect(sendMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ webhookUrl: 'https://arom.cd/hook', outboundSecret: 'arom-secret', partnerId: 'arom' }),
    )

    await notifyPartnerOfferStatusChanged('o-other', 'declined')
    expect(sendMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ webhookUrl: 'https://other.example/hook', outboundSecret: 'other-secret', partnerId: 'other-partner' }),
    )
  })

  it('onSuccess records a per-status notified-at timestamp on the offer', async () => {
    offers['o1'] = { partnerId: 'arom', listingId: 'l1', offerQuantityKg: 50, offerPricePerKgCdf: 800 }
    partners['arom'] = { webhookUrl: 'https://arom.cd/hook', outboundHmacSecret: 'secret' }
    await notifyPartnerOfferStatusChanged('o1', 'declined')
    const { onSuccess } = sendMock.mock.calls[0][0]
    await onSuccess()
    expect(offerUpdateMock).toHaveBeenCalledWith({ declinedNotifiedAt: 'SERVER_TIMESTAMP' })
  })
})
