import { describe, it, expect } from 'vitest'
import { initiateExternalInvoiceMobileMoney } from '../initiateExternalInvoiceMobileMoney'

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
