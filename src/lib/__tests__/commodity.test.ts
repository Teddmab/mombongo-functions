import { describe, it, expect } from 'vitest'
import { canonicalizeCommodity } from '../commodity'

describe('canonicalizeCommodity', () => {
  it('lowercases', () => {
    expect(canonicalizeCommodity('Ananas')).toBe('ananas')
  })

  it('trims leading/trailing whitespace', () => {
    expect(canonicalizeCommodity('  Ananas  ')).toBe('ananas')
  })

  it('collapses internal whitespace', () => {
    expect(canonicalizeCommodity('Ananas   frais')).toBe('ananas frais')
  })

  it('strips diacritics so accented and unaccented variants match', () => {
    expect(canonicalizeCommodity('Maïs')).toBe('mais')
    expect(canonicalizeCommodity('Mais')).toBe('mais')
  })

  it('treats different commodities as different codes', () => {
    expect(canonicalizeCommodity('Ananas')).not.toBe(canonicalizeCommodity('Manioc'))
  })

  it('is stable under repeated application', () => {
    const once = canonicalizeCommodity('  Ananas  ')
    expect(canonicalizeCommodity(once)).toBe(once)
  })
})
