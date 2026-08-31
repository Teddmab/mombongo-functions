import { describe, it, expect, vi, beforeEach } from 'vitest'
import axios from 'axios'

vi.mock('axios')

vi.mock('../../lib/admin', () => {
  const set = vi.fn()
  return {
    admin: {
      firestore: Object.assign(vi.fn(() => ({ collection: () => ({ doc: () => ({ set }) }) })), {
        FieldValue: { serverTimestamp: vi.fn(() => 'SERVER_TIMESTAMP') },
      }),
    },
    functions: {
      region: vi.fn(() => ({
        pubsub: { schedule: vi.fn(() => ({ timeZone: vi.fn(() => ({ onRun: vi.fn((h: unknown) => h) })) })) },
      })),
      logger: { info: vi.fn(), error: vi.fn() },
    },
    __mockSet: set,
  }
})

import { fetchUsdToCdfFromApi, refreshExchangeRateCore } from '../refreshExchangeRate'
import * as adminMock from '../../lib/admin'

const mockSet = (adminMock as unknown as { __mockSet: ReturnType<typeof vi.fn> }).__mockSet
const mockedAxios = vi.mocked(axios, true)

describe('fetchUsdToCdfFromApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the CDF rate from a successful response', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { result: 'success', rates: { CDF: 2292.21 } } })
    expect(await fetchUsdToCdfFromApi()).toBe(2292.21)
  })

  it('throws when the API reports a non-success result', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { result: 'error', rates: {} } })
    await expect(fetchUsdToCdfFromApi()).rejects.toThrow('result=error')
  })

  it('throws when the CDF rate is missing', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { result: 'success', rates: {} } })
    await expect(fetchUsdToCdfFromApi()).rejects.toThrow('missing a valid CDF rate')
  })

  it('throws when the CDF rate is not positive', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { result: 'success', rates: { CDF: 0 } } })
    await expect(fetchUsdToCdfFromApi()).rejects.toThrow('missing a valid CDF rate')
  })
})

describe('refreshExchangeRateCore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fetches the live rate and writes it to config/exchange_rate', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { result: 'success', rates: { CDF: 2400 } } })
    const rate = await refreshExchangeRateCore()
    expect(rate).toBe(2400)
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ usdToCdf: 2400, source: 'open.er-api.com' }),
      { merge: true },
    )
  })
})
