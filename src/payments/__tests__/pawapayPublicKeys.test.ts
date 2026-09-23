import axios from 'axios'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('axios')

import { getPawapayPublicKey, _resetPawapayPublicKeyCacheForTests } from '../pawapayPublicKeys'

const mockedAxios = vi.mocked(axios, true)

const KEYS_V1 = [{ id: 'HTTP_EC_P256_KEY:1', key: 'PEM_V1' }]
const KEYS_V2 = [{ id: 'HTTP_EC_P256_KEY:2', key: 'PEM_V2' }]

describe('getPawapayPublicKey', () => {
  beforeEach(() => {
    _resetPawapayPublicKeyCacheForTests()
    mockedAxios.get.mockReset()
  })

  it('fetches and returns the PEM for a known keyid', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: KEYS_V1 })
    expect(await getPawapayPublicKey('HTTP_EC_P256_KEY:1')).toBe('PEM_V1')
    expect(mockedAxios.get).toHaveBeenCalledTimes(1)
  })

  it('returns null for a keyid never seen in any fetch', async () => {
    mockedAxios.get.mockResolvedValue({ data: KEYS_V1 })
    expect(await getPawapayPublicKey('unknown-key')).toBeNull()
  })

  it('serves a second lookup from cache without refetching', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: KEYS_V1 })
    await getPawapayPublicKey('HTTP_EC_P256_KEY:1')
    await getPawapayPublicKey('HTTP_EC_P256_KEY:1')
    expect(mockedAxios.get).toHaveBeenCalledTimes(1)
  })

  it('force-refetches when asked, even if the cache already has an entry', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: KEYS_V1 }).mockResolvedValueOnce({ data: KEYS_V2 })
    expect(await getPawapayPublicKey('HTTP_EC_P256_KEY:1')).toBe('PEM_V1')
    expect(await getPawapayPublicKey('HTTP_EC_P256_KEY:2', true)).toBe('PEM_V2')
    expect(mockedAxios.get).toHaveBeenCalledTimes(2)
  })

  it('auto-refetches once when a keyid is unknown to the current cache (rotation without waiting out the TTL)', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: KEYS_V1 }).mockResolvedValueOnce({ data: KEYS_V2 })
    await getPawapayPublicKey('HTTP_EC_P256_KEY:1')
    expect(await getPawapayPublicKey('HTTP_EC_P256_KEY:2')).toBe('PEM_V2')
    expect(mockedAxios.get).toHaveBeenCalledTimes(2)
  })

  it('falls back to the previous cache on a network error rather than failing every call', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: KEYS_V1 })
    await getPawapayPublicKey('HTTP_EC_P256_KEY:1')
    mockedAxios.get.mockRejectedValueOnce(new Error('network down'))
    // Unknown keyid triggers a refetch attempt, which fails — should still
    // serve the previously-cached, still-valid key rather than nuking it.
    expect(await getPawapayPublicKey('HTTP_EC_P256_KEY:1', true)).toBe('PEM_V1')
  })

  it('returns null (fails closed) on a network error with no prior successful fetch', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('network down'))
    expect(await getPawapayPublicKey('HTTP_EC_P256_KEY:1')).toBeNull()
  })

  it('ignores malformed entries missing an id or key', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: [{ id: 'ok', key: 'PEM' }, { id: '', key: 'ignored' }, { id: 'no-key' }] })
    expect(await getPawapayPublicKey('ok')).toBe('PEM')
    expect(await getPawapayPublicKey('no-key')).toBeNull()
  })
})
