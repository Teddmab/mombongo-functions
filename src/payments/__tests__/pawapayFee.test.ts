import { describe, it, expect } from 'vitest'
import { extractPawapayFee } from '../pawapayFee'

describe('extractPawapayFee', () => {
  it('returns null when the body has no plausible fee field — never fabricates a number', () => {
    expect(extractPawapayFee({ depositId: 'd1', status: 'COMPLETED' })).toBeNull()
    expect(extractPawapayFee(null)).toBeNull()
    expect(extractPawapayFee('not an object')).toBeNull()
  })

  it('reads a top-level numeric fee field', () => {
    expect(extractPawapayFee({ depositId: 'd1', fee: 25 })).toBe(25)
  })

  it('reads a top-level string fee field', () => {
    expect(extractPawapayFee({ depositId: 'd1', fee: '25.5' })).toBe(25.5)
  })

  it('reads chargeFee / charges as alternate top-level names', () => {
    expect(extractPawapayFee({ chargeFee: 10 })).toBe(10)
    expect(extractPawapayFee({ charges: 12 })).toBe(12)
  })

  it('reads a nested amountDetails.fee', () => {
    expect(extractPawapayFee({ depositId: 'd1', amountDetails: { fee: 30 } })).toBe(30)
  })

  it('ignores a non-numeric string fee rather than returning NaN', () => {
    expect(extractPawapayFee({ fee: 'not-a-number' })).toBeNull()
  })
})
