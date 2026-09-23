import * as crypto from 'crypto'
import { describe, it, expect } from 'vitest'
import { verifyPawapayWebhookSignature } from '../verifyPawapayWebhookSignature'

const SECRET = 'test-webhook-secret'
const BODY = JSON.stringify({ depositId: 'dep1', status: 'COMPLETED' })

function sign(secret: string, body: string) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex')
}

describe('verifyPawapayWebhookSignature', () => {
  it('accepts a correctly signed request', () => {
    expect(verifyPawapayWebhookSignature(SECRET, sign(SECRET, BODY), BODY)).toBe(true)
  })

  it('rejects when the secret is missing (fail closed, not fail open)', () => {
    expect(verifyPawapayWebhookSignature(undefined, sign(SECRET, BODY), BODY)).toBe(false)
  })

  it('rejects when the signature header is missing (fail closed, not fail open)', () => {
    expect(verifyPawapayWebhookSignature(SECRET, undefined, BODY)).toBe(false)
  })

  it('rejects when both secret and signature are missing', () => {
    expect(verifyPawapayWebhookSignature(undefined, undefined, BODY)).toBe(false)
  })

  it('rejects a mismatched signature', () => {
    expect(verifyPawapayWebhookSignature(SECRET, sign('wrong-secret', BODY), BODY)).toBe(false)
  })

  it('rejects a signature computed over a different body', () => {
    expect(verifyPawapayWebhookSignature(SECRET, sign(SECRET, BODY), JSON.stringify({ depositId: 'dep2' }))).toBe(false)
  })

  it('rejects a signature of the wrong length without throwing', () => {
    expect(verifyPawapayWebhookSignature(SECRET, 'short', BODY)).toBe(false)
  })
})
