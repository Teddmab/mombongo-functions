import { describe, it, expect, vi, beforeEach } from 'vitest'

const tx = { get: vi.fn(), update: vi.fn() }
const users: Record<string, { role?: string } | undefined> = {}
const submissions: Record<string, Record<string, unknown> | undefined> = {}

function makeRef(collectionName: string, id: string) {
  return {
    id,
    collectionName,
    get: async () => ({
      data: () => (collectionName === 'users' ? users[id] : undefined),
    }),
  }
}

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => ({
      doc: (id: string) => makeRef(name, id),
    }),
    runTransaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(tx),
  },
  admin: {
    firestore: { FieldValue: { serverTimestamp: vi.fn(() => 'SERVER_TIMESTAMP') } },
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

import { adminReviewKyc } from '../adminReviewKyc'

type Handler = (data: unknown, context: { auth?: { uid: string } }) => Promise<unknown>

function mockGetForSubmission(uid: string) {
  tx.get.mockImplementation(async (ref: { collectionName: string; id: string }) => ({
    exists: ref.collectionName === 'kyc_submissions' && submissions[uid] !== undefined,
    data: () => submissions[uid],
  }))
}

describe('adminReviewKyc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const k of Object.keys(users)) delete users[k]
    for (const k of Object.keys(submissions)) delete submissions[k]
  })

  it('rejects an unauthenticated caller', async () => {
    await expect(
      (adminReviewKyc as unknown as Handler)({ uid: 'farmer1', decision: 'approve' }, {}),
    ).rejects.toThrow('Login required')
  })

  it('rejects a non-admin caller', async () => {
    users['u1'] = { role: 'agent' }
    await expect(
      (adminReviewKyc as unknown as Handler)({ uid: 'farmer1', decision: 'approve' }, { auth: { uid: 'u1' } }),
    ).rejects.toThrow('Admin only')
  })

  it('rejects an invalid decision value', async () => {
    users['admin1'] = { role: 'admin' }
    await expect(
      (adminReviewKyc as unknown as Handler)({ uid: 'farmer1', decision: 'delete' }, { auth: { uid: 'admin1' } }),
    ).rejects.toThrow('decision must be one of')
  })

  it('requires a reason to reject', async () => {
    users['admin1'] = { role: 'admin' }
    await expect(
      (adminReviewKyc as unknown as Handler)({ uid: 'farmer1', decision: 'reject' }, { auth: { uid: 'admin1' } }),
    ).rejects.toThrow('reason is required')
  })

  it('requires a reason to request a correction', async () => {
    users['admin1'] = { role: 'admin' }
    await expect(
      (adminReviewKyc as unknown as Handler)({ uid: 'farmer1', decision: 'request_correction' }, { auth: { uid: 'admin1' } }),
    ).rejects.toThrow('reason is required')
  })

  it('404s when there is no submission for that uid', async () => {
    users['admin1'] = { role: 'admin' }
    mockGetForSubmission('farmer1')
    await expect(
      (adminReviewKyc as unknown as Handler)({ uid: 'farmer1', decision: 'approve' }, { auth: { uid: 'admin1' } }),
    ).rejects.toThrow('No KYC submission')
  })

  it('rejects (double-submit guard) when the submission is no longer pending', async () => {
    users['admin1'] = { role: 'admin' }
    submissions['farmer1'] = { status: 'approved' }
    mockGetForSubmission('farmer1')
    await expect(
      (adminReviewKyc as unknown as Handler)({ uid: 'farmer1', decision: 'approve' }, { auth: { uid: 'admin1' } }),
    ).rejects.toThrow('déjà été traité')
  })

  it('approves: sets kyc_submissions.status and users.kycStatus to the value the farmer app understands', async () => {
    users['admin1'] = { role: 'admin' }
    submissions['farmer1'] = { status: 'pending' }
    mockGetForSubmission('farmer1')

    const result = await (adminReviewKyc as unknown as Handler)(
      { uid: 'farmer1', decision: 'approve' }, { auth: { uid: 'admin1' } },
    )

    expect(result).toEqual({ success: true, status: 'approved' })
    expect(tx.update).toHaveBeenCalledWith(
      expect.objectContaining({ collectionName: 'kyc_submissions' }),
      expect.objectContaining({ status: 'approved', reviewedBy: 'admin1' }),
    )
    expect(tx.update).toHaveBeenCalledWith(
      expect.objectContaining({ collectionName: 'users' }),
      expect.objectContaining({ kycStatus: 'approved', kycVerifiedAt: 'SERVER_TIMESTAMP' }),
    )
  })

  it('rejects with the reason recorded', async () => {
    users['admin1'] = { role: 'admin' }
    submissions['farmer1'] = { status: 'pending' }
    mockGetForSubmission('farmer1')

    await (adminReviewKyc as unknown as Handler)(
      { uid: 'farmer1', decision: 'reject', reason: 'Photo illisible' }, { auth: { uid: 'admin1' } },
    )

    expect(tx.update).toHaveBeenCalledWith(
      expect.objectContaining({ collectionName: 'kyc_submissions' }),
      expect.objectContaining({ status: 'rejected', rejectionReason: 'Photo illisible' }),
    )
    expect(tx.update).toHaveBeenCalledWith(
      expect.objectContaining({ collectionName: 'users' }),
      expect.objectContaining({ kycStatus: 'rejected' }),
    )
  })

  it('request_correction keeps users.kycStatus at pending (farmer app has no 4th state)', async () => {
    users['admin1'] = { role: 'admin' }
    submissions['farmer1'] = { status: 'pending' }
    mockGetForSubmission('farmer1')

    const result = await (adminReviewKyc as unknown as Handler)(
      { uid: 'farmer1', decision: 'request_correction', reason: 'Verso manquant' }, { auth: { uid: 'admin1' } },
    )

    expect(result).toEqual({ success: true, status: 'correction_requested' })
    expect(tx.update).toHaveBeenCalledWith(
      expect.objectContaining({ collectionName: 'kyc_submissions' }),
      expect.objectContaining({ status: 'correction_requested', rejectionReason: 'Verso manquant' }),
    )
    expect(tx.update).toHaveBeenCalledWith(
      expect.objectContaining({ collectionName: 'users' }),
      expect.objectContaining({ kycStatus: 'pending' }),
    )
  })
})
