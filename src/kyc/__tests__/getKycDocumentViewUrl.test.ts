import { describe, it, expect, vi, beforeEach } from 'vitest'

const users: Record<string, { role?: string } | undefined> = {}
const submissions: Record<string, Record<string, unknown> | undefined> = {}
const signedUrlCalls: string[] = []

vi.mock('../../lib/admin', () => ({
  admin: {
    firestore: () => ({
      collection: (name: string) => ({
        doc: (id: string) => ({
          get: async () => {
            const data = name === 'users' ? users[id] : submissions[id]
            return { exists: data !== undefined, data: () => data }
          },
        }),
      }),
    }),
    storage: () => ({
      bucket: () => ({
        file: (path: string) => ({
          getSignedUrl: async () => {
            signedUrlCalls.push(path)
            return [`https://signed.example/${path}`]
          },
        }),
      }),
    }),
  },
  functions: {
    region: vi.fn(() => ({ https: { onCall: vi.fn((h: unknown) => h) } })),
    https: { HttpsError: class extends Error { constructor(public code: string, msg: string) { super(msg) } } },
    logger: { info: vi.fn() },
  },
}))

import { getKycDocumentViewUrl } from '../getKycDocumentViewUrl'

type Handler = (data: unknown, context: { auth?: { uid: string } }) => Promise<unknown>
const call = getKycDocumentViewUrl as unknown as Handler

describe('getKycDocumentViewUrl', () => {
  beforeEach(() => {
    signedUrlCalls.length = 0
    for (const k of Object.keys(users)) delete users[k]
    for (const k of Object.keys(submissions)) delete submissions[k]
    users['admin1'] = { role: 'admin' }
    submissions['farmer1'] = { documentType: 'cni', photoUrls: ['kyc_documents/farmer1/1-0.jpg', 'kyc_documents/farmer1/1-1.jpg'] }
  })

  it('rejects a non-admin caller', async () => {
    users['u1'] = { role: 'merchant' }
    await expect(call({ uid: 'farmer1' }, { auth: { uid: 'u1' } })).rejects.toThrow('Admin only')
  })

  it('404s when no submission exists', async () => {
    await expect(call({ uid: 'ghost' }, { auth: { uid: 'admin1' } })).rejects.toThrow('No KYC submission')
  })

  it('returns one short-lived signed URL per stored document path', async () => {
    const result = await call({ uid: 'farmer1' }, { auth: { uid: 'admin1' } }) as { documentType: string; urls: string[] }
    expect(result.documentType).toBe('cni')
    expect(result.urls).toEqual([
      'https://signed.example/kyc_documents/farmer1/1-0.jpg',
      'https://signed.example/kyc_documents/farmer1/1-1.jpg',
    ])
    expect(signedUrlCalls).toHaveLength(2)
  })
})
