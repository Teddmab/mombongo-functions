import { describe, it, expect, vi, beforeEach } from 'vitest'

const users: Record<string, { role?: string } | undefined> = {}
const submissions: Record<string, Record<string, unknown> | undefined> = {}
const getSignedUrlMock = vi.fn(async () => ['https://signed.example.com/doc.jpg'])

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => {
      if (name === 'users') {
        return { doc: (id: string) => ({ get: async () => ({ data: () => users[id] }) }) }
      }
      if (name === 'kyc_submissions') {
        return {
          doc: (id: string) => ({
            get: async () => ({ exists: submissions[id] !== undefined, data: () => submissions[id] }),
          }),
        }
      }
      throw new Error(`unexpected collection ${name}`)
    },
  },
  admin: {
    storage: () => ({
      bucket: () => ({
        file: (_path: string) => ({ getSignedUrl: getSignedUrlMock }),
      }),
    }),
  },
  functions: {
    region: vi.fn(() => ({ https: { onCall: vi.fn((h: unknown) => h) } })),
    https: {
      HttpsError: class extends Error {
        constructor(public code: string, msg: string) { super(msg) }
      },
    },
  },
}))

import { adminGetKycDocumentUrls } from '../adminGetKycDocumentUrls'

type Handler = (data: unknown, context: { auth?: { uid: string } }) => Promise<unknown>

describe('adminGetKycDocumentUrls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const k of Object.keys(users)) delete users[k]
    for (const k of Object.keys(submissions)) delete submissions[k]
  })

  it('rejects an unauthenticated caller', async () => {
    await expect((adminGetKycDocumentUrls as unknown as Handler)({ uid: 'farmer1' }, {})).rejects.toThrow('Login required')
  })

  it('rejects a non-admin caller', async () => {
    users['u1'] = { role: 'farmer' }
    await expect(
      (adminGetKycDocumentUrls as unknown as Handler)({ uid: 'farmer1' }, { auth: { uid: 'u1' } }),
    ).rejects.toThrow('Admin only')
  })

  it('404s when the farmer has no KYC submission', async () => {
    users['admin1'] = { role: 'admin' }
    await expect(
      (adminGetKycDocumentUrls as unknown as Handler)({ uid: 'farmer1' }, { auth: { uid: 'admin1' } }),
    ).rejects.toThrow('No KYC submission')
  })

  it('returns signed read URLs for every stored document path, never the raw path', async () => {
    users['admin1'] = { role: 'admin' }
    submissions['farmer1'] = {
      documentType: 'cni',
      photoUrls: ['kyc_documents/farmer1/1-0.jpg', 'kyc_documents/farmer1/1-1.jpg'],
      status: 'pending',
      submittedAt: { seconds: 1 },
      reviewedAt: null,
      reviewedBy: null,
      rejectionReason: null,
    }

    const result = await (adminGetKycDocumentUrls as unknown as Handler)(
      { uid: 'farmer1' }, { auth: { uid: 'admin1' } },
    ) as { photoUrls: string[]; documentType: string; status: string }

    expect(getSignedUrlMock).toHaveBeenCalledTimes(2)
    expect(getSignedUrlMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'read', version: 'v4' }))
    expect(result.photoUrls).toEqual([
      'https://signed.example.com/doc.jpg',
      'https://signed.example.com/doc.jpg',
    ]);
    expect(result.photoUrls.every(u => !u.startsWith('kyc_documents/'))).toBe(true)
    expect(result.documentType).toBe('cni')
    expect(result.status).toBe('pending')
  })
})
