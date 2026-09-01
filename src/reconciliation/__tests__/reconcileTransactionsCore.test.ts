import { describe, it, expect, vi, beforeEach } from 'vitest'

const deposits: Record<string, Record<string, unknown> | undefined> = {}
const withdrawals: Record<string, Record<string, unknown> | undefined> = {}
const invoices: Record<string, Record<string, unknown> | undefined> = {}
const transactions: Record<string, { data: Record<string, unknown>; ref: { update: ReturnType<typeof vi.fn> } }> = {}

function makeDoc(store: Record<string, Record<string, unknown> | undefined>, id: string) {
  return { get: async () => ({ exists: store[id] !== undefined, data: () => store[id] }) }
}

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => ({
      doc: (id: string) => {
        if (name === 'deposits') return makeDoc(deposits, id)
        if (name === 'withdrawals') return makeDoc(withdrawals, id)
        if (name === 'external_invoices') return makeDoc(invoices, id)
        throw new Error(`unexpected collection ${name}`)
      },
      where: () => ({
        orderBy: () => ({
          limit: () => ({
            get: async () => ({
              docs: Object.entries(transactions).map(([id, t]) => ({ id, data: () => t.data, ref: t.ref })),
            }),
          }),
        }),
      }),
    }),
  },
  admin: {
    firestore: Object.assign(
      () => ({}),
      {
        FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' },
        Timestamp: { fromDate: (d: Date) => d },
      },
    ),
  },
}))

import { reconcileOneTransaction, reconcileRecentTransactions } from '../reconcileTransactionsCore'

describe('reconcileOneTransaction', () => {
  beforeEach(() => {
    for (const store of [deposits, withdrawals, invoices]) for (const k of Object.keys(store)) delete store[k]
  })

  it('flags a deposit transaction whose deposits doc is missing', async () => {
    const result = await reconcileOneTransaction('tx1', { type: 'deposit', pawapayDepositId: 'd1', amountUsd: 50 })
    expect(result).toEqual({ status: 'exception', note: 'Aucun document deposits correspondant' })
  })

  it('flags a deposit whose underlying deposits doc never reached completed', async () => {
    deposits['d1'] = { status: 'pending', amountUsd: 50 }
    const result = await reconcileOneTransaction('tx1', { type: 'deposit', pawapayDepositId: 'd1', amountUsd: 50 })
    expect(result.status).toBe('exception')
    expect(result.note).toMatch(/pending/)
  })

  it('flags an amount mismatch between the transaction and the deposits doc', async () => {
    deposits['d1'] = { status: 'completed', amountUsd: 75 }
    const result = await reconcileOneTransaction('tx1', { type: 'deposit', pawapayDepositId: 'd1', amountUsd: 50 })
    expect(result.status).toBe('exception')
    expect(result.note).toMatch(/Montant différent/)
  })

  it('matches a consistent deposit', async () => {
    deposits['d1'] = { status: 'completed', amountUsd: 50 }
    const result = await reconcileOneTransaction('tx1', { type: 'deposit', pawapayDepositId: 'd1', amountUsd: 50 })
    expect(result).toEqual({ status: 'matched', note: null })
  })

  it('matches a consistent withdrawal', async () => {
    withdrawals['w1'] = { status: 'completed', amountUsd: 20 }
    const result = await reconcileOneTransaction('tx1', { type: 'withdrawal', pawapayPayoutId: 'w1', amountUsd: 20 })
    expect(result).toEqual({ status: 'matched', note: null })
  })

  it('matches a consistent external_invoice_payment', async () => {
    invoices['inv1'] = { status: 'paid', amountUsd: 100 }
    const result = await reconcileOneTransaction('tx1', { type: 'external_invoice_payment', externalInvoiceDocId: 'inv1', amountUsd: 100 })
    expect(result).toEqual({ status: 'matched', note: null })
  })

  it('flags an invoice payment whose invoice never reached paid', async () => {
    invoices['inv1'] = { status: 'checkout_created', amountUsd: 100 }
    const result = await reconcileOneTransaction('tx1', { type: 'external_invoice_payment', externalInvoiceDocId: 'inv1', amountUsd: 100 })
    expect(result.status).toBe('exception')
  })

  it('marks types with no independent secondary record as not_applicable, never as a false "matched"', async () => {
    expect(await reconcileOneTransaction('tx1', { type: 'investment', amountUsd: 100 })).toEqual({ status: 'not_applicable', note: null })
    expect(await reconcileOneTransaction('tx1', { type: 'bourse_sale', amountCdf: 5000 })).toEqual({ status: 'not_applicable', note: null })
    expect(await reconcileOneTransaction('tx1', { type: 'financing', amountUsd: 100 })).toEqual({ status: 'not_applicable', note: null })
  })
})

describe('reconcileRecentTransactions', () => {
  beforeEach(() => {
    for (const store of [deposits, withdrawals, invoices, transactions]) for (const k of Object.keys(store)) delete (store as Record<string, unknown>)[k]
  })

  it('skips transactions that were already checked in a prior run', async () => {
    const update = vi.fn()
    transactions['tx1'] = { data: { type: 'deposit', pawapayDepositId: 'd1', amountUsd: 10, reconciliationCheckedAt: 'already-checked' }, ref: { update } }
    const result = await reconcileRecentTransactions(7, 200)
    expect(update).not.toHaveBeenCalled()
    expect(result.checked).toBe(0)
  })

  it('checks unchecked transactions and writes the result, counting exceptions', async () => {
    const update1 = vi.fn()
    const update2 = vi.fn()
    deposits['d1'] = { status: 'completed', amountUsd: 10 }
    transactions['tx1'] = { data: { type: 'deposit', pawapayDepositId: 'd1', amountUsd: 10 }, ref: { update: update1 } }
    transactions['tx2'] = { data: { type: 'deposit', pawapayDepositId: 'missing', amountUsd: 10 }, ref: { update: update2 } }

    const result = await reconcileRecentTransactions(7, 200)

    expect(result).toEqual({ checked: 2, exceptions: 1 })
    expect(update1).toHaveBeenCalledWith(expect.objectContaining({ reconciliationStatus: 'matched' }))
    expect(update2).toHaveBeenCalledWith(expect.objectContaining({ reconciliationStatus: 'exception' }))
  })

  it('stops once it hits the per-run limit', async () => {
    for (let i = 0; i < 5; i++) {
      transactions[`tx${i}`] = { data: { type: 'investment', amountUsd: 1 }, ref: { update: vi.fn() } }
    }
    const result = await reconcileRecentTransactions(7, 2)
    expect(result.checked).toBe(2)
  })
})
