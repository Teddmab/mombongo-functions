import { describe, it, expect, vi, beforeEach } from 'vitest'

const users: Record<string, Record<string, unknown> | undefined> = {}
const usersByEmail: Record<string, string> = {} // email -> uid
let userCounter = 0

function makeDocRef(id: string) {
  return {
    id,
    get: async () => ({ exists: users[id] !== undefined, data: () => users[id], ref: { id } }),
    set: (data: Record<string, unknown>) => { users[id] = data },
  };
}

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => {
      if (name !== 'users') throw new Error(`unexpected collection ${name}`);
      return {
        doc: (id: string) => makeDocRef(id),
        where: (field: string, _op: string, value: unknown) => ({
          where: (field2: string, _op2: string, value2: unknown) => ({
            limit: () => ({
              get: async () => {
                const matches = Object.entries(users).filter(([, u]) =>
                  u?.[field] === value && u?.[field2] === value2);
                return { empty: matches.length === 0, docs: matches.map(([id, data]) => ({ id, data: () => data })) };
              },
            }),
          }),
        }),
      };
    },
  },
  auth: {
    getUserByEmail: async (email: string) => {
      const uid = usersByEmail[email];
      if (!uid) throw new Error('user-not-found');
      return { uid };
    },
    createUser: async ({ email }: { email: string }) => {
      const uid = `uid${++userCounter}`;
      usersByEmail[email] = uid;
      return { uid };
    },
  },
  admin: {
    firestore: Object.assign(() => ({}), {
      FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' },
      Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) },
    }),
  },
  functions: {
    region: vi.fn(() => ({ https: { onCall: vi.fn((h: unknown) => h) } })),
    https: { HttpsError: class extends Error { constructor(public code: string, msg: string) { super(msg) } } },
    logger: { info: vi.fn() },
  },
}))

import { adminCreatePerson } from '../adminCreatePerson'

type Handler = (data: unknown, context: { auth?: { uid: string } }) => Promise<{ uid: string; isNew: boolean; fullName: string }>
const call = adminCreatePerson as unknown as Handler

const VALID_FARMER = {
  role: 'farmer' as const,
  fullName: 'Jean Kabila',
  phone: '+243811234567',
  province: 'Kasaï',
  consentMethod: 'field_agent' as const,
  consentAt: '2026-09-01T10:00:00.000Z',
};

describe('adminCreatePerson', () => {
  beforeEach(() => {
    userCounter = 0;
    for (const k of Object.keys(users)) delete users[k];
    for (const k of Object.keys(usersByEmail)) delete usersByEmail[k];
    users['admin1'] = { role: 'admin' };
  });

  it('rejects a non-admin caller', async () => {
    users['u1'] = { role: 'farmer' };
    await expect(call(VALID_FARMER, { auth: { uid: 'u1' } })).rejects.toThrow('Admin only');
  });

  it('rejects a role other than farmer or merchant', async () => {
    await expect(call({ ...VALID_FARMER, role: 'investor' }, { auth: { uid: 'admin1' } })).rejects.toThrow('role must be');
  });

  it('rejects a missing fullName or phone', async () => {
    await expect(call({ ...VALID_FARMER, fullName: '' }, { auth: { uid: 'admin1' } })).rejects.toThrow('fullName required');
    await expect(call({ ...VALID_FARMER, phone: '' }, { auth: { uid: 'admin1' } })).rejects.toThrow('phone required');
  });

  it('creates a farmer, admin-attested and immediately usable', async () => {
    const result = await call(VALID_FARMER, { auth: { uid: 'admin1' } });
    expect(result.isNew).toBe(true);
    expect(users[result.uid]).toMatchObject({
      role: 'farmer',
      fullName: 'Jean Kabila',
      phone: '+243811234567',
      province: 'Kasaï',
      kycStatus: 'approved',
      adminCreated: true,
      createdBy: 'admin1',
      verificationMethod: 'admin_attested',
    });
    expect((users[result.uid] as any).adminAssisted).toMatchObject({
      actorUid: 'admin1', consentMethod: 'field_agent',
    });
  });

  it('creates a merchant with businessType and no province', async () => {
    const result = await call({
      role: 'merchant', fullName: 'Alimentation Bondeko', phone: '+243899999999',
      businessType: 'grossiste', consentMethod: 'phone', consentAt: '2026-09-01T10:00:00.000Z',
    }, { auth: { uid: 'admin1' } });
    expect(users[result.uid]).toMatchObject({ role: 'merchant', businessType: 'grossiste', province: null, kycStatus: 'approved' });
  });

  it('reuses the existing account on a retry for the same phone and role instead of creating a duplicate', async () => {
    const first = await call(VALID_FARMER, { auth: { uid: 'admin1' } });
    const second = await call(VALID_FARMER, { auth: { uid: 'admin1' } });
    expect(second.uid).toBe(first.uid);
    expect(second.isNew).toBe(false);
  });

  it('does not collide with a different role using the same phone', async () => {
    const farmer = await call(VALID_FARMER, { auth: { uid: 'admin1' } });
    const merchant = await call({
      role: 'merchant', fullName: 'Boutique Kabila', phone: VALID_FARMER.phone,
      consentMethod: 'phone', consentAt: '2026-09-01T10:00:00.000Z',
    }, { auth: { uid: 'admin1' } });
    expect(merchant.uid).not.toBe(farmer.uid);
  });
});
