import { describe, it, expect, vi, beforeEach } from 'vitest'
import axios from 'axios'

vi.mock('axios')
vi.mock('../../lib/admin', () => ({ db: {} }))
vi.mock('../../payments/initiateDeposit', () => ({
  getUsdToCdf: vi.fn(async () => 3000),
}))

import { initiateExternalInvoiceMobileMoney } from '../initiateExternalInvoiceMobileMoney'

const mockedAxios = vi.mocked(axios, true)

describe('initiateExternalInvoiceMobileMoney — input validation', () => {
  it('rejects an unknown operator before making any provider call', async () => {
    await expect(
      initiateExternalInvoiceMobileMoney({ amountUsd: 10, phone: '+243900000000', operator: 'unknown_operator' }),
    ).rejects.toThrow('Unknown operator')
  })

  it('rejects a missing phone before making any provider call', async () => {
    await expect(
      initiateExternalInvoiceMobileMoney({ amountUsd: 10, phone: '', operator: 'mpesa' }),
    ).rejects.toThrow('phone required')
  })
})

describe('initiateExternalInvoiceMobileMoney — live exchange rate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedAxios.post.mockResolvedValue({ data: { status: 'ACCEPTED' } })
  })

  it('converts amountUsd to CDF using the live rate, not a hardcoded one', async () => {
    await initiateExternalInvoiceMobileMoney({ amountUsd: 10, phone: '+243900000000', operator: 'mpesa' })
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v1/deposits'),
      expect.objectContaining({ amount: '30000', currency: 'CDF' }), // 10 * 3000 (mocked live rate)
      expect.anything(),
    )
  })
})
