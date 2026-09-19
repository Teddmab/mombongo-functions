import { describe, it, expect } from 'vitest'
import { computeEventId } from '../eventId'

describe('computeEventId', () => {
  it('is deterministic for the same inputs', () => {
    expect(computeEventId('invoice_issued', 'inv1')).toBe(computeEventId('invoice_issued', 'inv1'))
  })

  it('differs by kind', () => {
    expect(computeEventId('invoice_issued', 'x')).not.toBe(computeEventId('payment_complete', 'x'))
  })

  it('differs by any part', () => {
    expect(computeEventId('offer_status_changed', 'o1', 'accepted'))
      .not.toBe(computeEventId('offer_status_changed', 'o1', 'declined'))
    expect(computeEventId('offer_status_changed', 'o1', 'accepted'))
      .not.toBe(computeEventId('offer_status_changed', 'o2', 'accepted'))
  })

  it('is not trivially guessable/sequential — looks like a hash, not a counter', () => {
    const id = computeEventId('invoice_issued', 'inv1')
    expect(id).toMatch(/^[0-9a-f]{64}$/)
  })
})
