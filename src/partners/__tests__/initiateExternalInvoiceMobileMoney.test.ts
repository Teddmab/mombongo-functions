import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import axios from 'axios'

vi.mock('axios')
vi.mock('../../lib/admin', () => ({ db: {} }))
vi.mock('../../payments/initiateDeposit', () => ({
  getUsdToCdf: vi.fn(async () => 3000),
}))

import { initiateExternalInvoiceMobileMoney, PawapaySandboxNotConfiguredError } from '../initiateExternalInvoiceMobileMoney'

const mockedAxios = vi.mocked(axios, true)

describe('initiateExternalInvoiceMobileMoney — input validation', () => {
  it('rejects an unknown operator before making any provider call', async () => {
    await expect(
      initiateExternalInvoiceMobileMoney({ amountUsd: 10, phone: '+243900000000', operator: 'unknown_operator', testMode: false }),
    ).rejects.toThrow('Unknown operator')
  })

  it('rejects a missing phone before making any provider call', async () => {
    await expect(
      initiateExternalInvoiceMobileMoney({ amountUsd: 10, phone: '', operator: 'mpesa', testMode: false }),
    ).rejects.toThrow('phone required')
  })
})

describe('initiateExternalInvoiceMobileMoney — live exchange rate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedAxios.post.mockResolvedValue({ data: { status: 'ACCEPTED' } })
  })

  it('converts amountUsd to CDF using the live rate, not a hardcoded one', async () => {
    await initiateExternalInvoiceMobileMoney({ amountUsd: 10, phone: '+243900000000', operator: 'mpesa', testMode: false })
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v1/deposits'),
      expect.objectContaining({ amount: '30000', currency: 'CDF' }), // 10 * 3000 (mocked live rate)
      expect.anything(),
    )
  })

  it('uses the production PawaPay host for a non-testMode call', async () => {
    await initiateExternalInvoiceMobileMoney({ amountUsd: 10, phone: '+243900000000', operator: 'mpesa', testMode: false })
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.pawapay.cloud/v1/deposits',
      expect.anything(),
      expect.anything(),
    )
  })
})

describe('initiateExternalInvoiceMobileMoney — sandbox routing (testMode)', () => {
  const ORIGINAL_ENV = process.env.PAWAPAY_API_KEY_SANDBOX

  beforeEach(() => vi.clearAllMocks())

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.PAWAPAY_API_KEY_SANDBOX
    else process.env.PAWAPAY_API_KEY_SANDBOX = ORIGINAL_ENV
  })

  it('fails closed instead of falling back to production when sandbox is not configured', async () => {
    delete process.env.PAWAPAY_API_KEY_SANDBOX
    await expect(
      initiateExternalInvoiceMobileMoney({ amountUsd: 10, phone: '+243900000000', operator: 'mpesa', testMode: true }),
    ).rejects.toBeInstanceOf(PawapaySandboxNotConfiguredError)
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })

  it('uses the sandbox PawaPay host once PAWAPAY_API_KEY_SANDBOX is configured', async () => {
    process.env.PAWAPAY_API_KEY_SANDBOX = 'fake-sandbox-key'
    vi.clearAllMocks()
    mockedAxios.post.mockResolvedValue({ data: { status: 'ACCEPTED' } })
    await initiateExternalInvoiceMobileMoney({ amountUsd: 10, phone: '+243900000000', operator: 'mpesa', testMode: true })
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.sandbox.pawapay.io/v1/deposits',
      expect.anything(),
      expect.objectContaining({ headers: { Authorization: 'Bearer fake-sandbox-key' } }),
    )
  })
})
