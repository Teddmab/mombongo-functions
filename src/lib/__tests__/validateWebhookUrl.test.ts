import { describe, it, expect } from 'vitest'
import { validateWebhookUrl } from '../validateWebhookUrl'

describe('validateWebhookUrl', () => {
  it('accepts a normal https URL', () => {
    expect(validateWebhookUrl('https://webhooks.arom.cd/mombongo')).toEqual({ valid: true })
  })

  it('rejects http://', () => {
    expect(validateWebhookUrl('http://webhooks.arom.cd/mombongo').valid).toBe(false)
  })

  it('rejects a malformed URL', () => {
    expect(validateWebhookUrl('not a url').valid).toBe(false)
  })

  it('rejects localhost', () => {
    expect(validateWebhookUrl('https://localhost:3000/hook').valid).toBe(false)
  })

  it('rejects 0.0.0.0', () => {
    expect(validateWebhookUrl('https://0.0.0.0/hook').valid).toBe(false)
  })

  it('rejects .internal / .local suffixes', () => {
    expect(validateWebhookUrl('https://api.internal/hook').valid).toBe(false)
    expect(validateWebhookUrl('https://box.local/hook').valid).toBe(false)
  })

  it('rejects loopback IPv4', () => {
    expect(validateWebhookUrl('https://127.0.0.1/hook').valid).toBe(false)
  })

  it('rejects private IPv4 ranges (10.x, 172.16-31.x, 192.168.x)', () => {
    expect(validateWebhookUrl('https://10.0.0.5/hook').valid).toBe(false)
    expect(validateWebhookUrl('https://172.16.0.5/hook').valid).toBe(false)
    expect(validateWebhookUrl('https://172.31.255.255/hook').valid).toBe(false)
    expect(validateWebhookUrl('https://192.168.1.1/hook').valid).toBe(false)
  })

  it('accepts a public-looking 172.x address outside the private range', () => {
    expect(validateWebhookUrl('https://172.15.0.1/hook')).toEqual({ valid: true })
    expect(validateWebhookUrl('https://172.32.0.1/hook')).toEqual({ valid: true })
  })

  it('rejects link-local IPv4 (169.254.x)', () => {
    expect(validateWebhookUrl('https://169.254.1.1/hook').valid).toBe(false)
  })

  it('rejects loopback and unique-local IPv6', () => {
    expect(validateWebhookUrl('https://[::1]/hook').valid).toBe(false)
    expect(validateWebhookUrl('https://[fe80::1]/hook').valid).toBe(false)
    expect(validateWebhookUrl('https://[fd00::1]/hook').valid).toBe(false)
  })

  it('accepts a public IPv4 literal', () => {
    expect(validateWebhookUrl('https://8.8.8.8/hook')).toEqual({ valid: true })
  })
})
