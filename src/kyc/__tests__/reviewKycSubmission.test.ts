import { describe, it, expect, vi, beforeEach } from 'vitest'

const users: Record<string, { role?: string } | undefined> = {}
const submissions: Record<string, Record<string, unknown> | undefined> = {}
const updates: { ref: string; data: Record<string, unknown> }[] = []

function makeDocRef(collectionName: string, id: string) {
  return {
    id,
    get: async () => {
      const data = collectionName === 'users' ? users[id] : submissions[id]
      return { exists: data !== undefined, data: () => data }
    },
    update: (data: Record<string, unknown>) => {
      updates.push({ ref: `${collectionName}/${id}`, data })
      if (collectionName === 'users') users[id] = { ...(users[id] ?? {}), ...data } as { role?: string }
      else submissions[id] = { ...(submissions[id] ?? {}), ...data }
    },
  }
}

vi.mock('../../lib/admin', () => ({
  admin: {
    firestore: Object.assign(
      () => ({
        collection: (name: string) => ({
          doc: (id: string) => makeDocRef(name, id),
        }),
        runTransaction: async (fn: (tx: unknown) => Promise<void>) => {
          const tx = {
            get: async (ref: ReturnType<typeof makeDocRef>) => ref.get(),
            update: (ref: ReturnType<typeof makeDocRef>, data: Record<string, unknown>) => ref.update(data),
          }
          await fn(tx)
        },
      }),
      { FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' } },
    ),
  },
  functions: {
    region: vi.fn(() => ({ https: { onCall: vi.fn((h: unknown) => h) } })),
    https: { HttpsError: class extends Error { constructor(public code: string, msg: string) { super(msg) } } },
    logger: { info: vi.fn() },
  },
}))

import { reviewKycSubmission } from '../reviewKycSubmission'

type Handler = (data: unknown, context: { auth?: { uid: string } }) => Promise<unknown>
const call = reviewKycSubmission as unknown as Handler

describe('reviewKycSubmission', () => {
  beforeEach(() => {
    updates.length = 0
    for (const k of Object.keys(users)) delete users[k]
    for (const k of Object.keys(submissions)) delete submissions[k]
    users['admin1'] = { role: 'admin' }
    users['farmer1'] = { role: 'farmer' }
    submissions['farmer1'] = { documentType: 'cni', photoUrls: ['a.jpg'], status: 'pending' }
  })

  it('rejects an unauthenticated caller', async () => {
    await expect(call({ uid: 'farmer1', decision: 'verified' }, {})).rejects.toThrow('Login required')
  })

  it('rejects a non-admin caller', async () => {
    await expect(
      call({ uid: 'farmer1', decision: 'verified' }, { auth: { uid: 'farmer1' } }),
    ).rejects.toThrow('Admin only')
  })

  it('requires a reason for rejection', async () => {
    await expect(
      call({ uid: 'farmer1', decision: 'rejected' }, { auth: { uid: 'admin1' } }),
    ).rejects.toThrow('reason is required')
  })

  it('requires a reason for a correction request', async () => {
    await expect(
      call({ uid: 'farmer1', decision: 'correction_requested' }, { auth: { uid: 'admin1' } }),
    ).rejects.toThrow('reason is required')
  })

  it('404s when no submission exists for the user', async () => {
    await expect(
      call({ uid: 'ghost', decision: 'verified' }, { auth: { uid: 'admin1' } }),
    ).rejects.toThrow('No KYC submission')
  })

  it('approves a submission and records the reviewing admin', async () => {
    const result = await call({ uid: 'farmer1', decision: 'verified' }, { auth: { uid: 'admin1' } })
    expect(result).toEqual({ success: true })
    expect(submissions['farmer1']).toMatchObject({ status: 'verified', reviewedBy: 'admin1', rejectionReason: null })
    expect(users['farmer1']).toMatchObject({ kycStatus: 'verified' })
  })

  it('rejects with a reason and stores it', async () => {
    await call({ uid: 'farmer1', decision: 'rejected', reason: 'Photo illisible' }, { auth: { uid: 'admin1' } })
    expect(submissions['farmer1']).toMatchObject({ status: 'rejected', rejectionReason: 'Photo illisible' })
    expect(users['farmer1']).toMatchObject({ kycStatus: 'rejected' })
  })
})
