/**
 * One-time seed script for required Firestore config documents.
 * Run from mombongo-functions/:
 *   npx ts-node --project tsconfig.json scripts/seed-config.ts
 */
import * as admin from 'firebase-admin'

if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'mombongo-dev' })
}

const db = admin.firestore()

async function seed() {
  // ── SF-03: exchange rate used by getFarmPnlSummary / getCropProfitability ──
  await db.collection('config').doc('exchange_rate').set(
    { usdToCdf: 2800 },
    { merge: true }
  )
  console.log('✓ config/exchange_rate  →  usdToCdf: 2800')

  // ── SF-04: sample province_prices for checkFarmerPriceAlerts ───────────────
  const now = admin.firestore.Timestamp.now()
  const samples = [
    { commodity: 'Manioc', province: 'Kinshasa',      priceUsd: 0.38, updatedAt: now },
    { commodity: 'Maïs',   province: 'Kinshasa',      priceUsd: 0.18, updatedAt: now },
    { commodity: 'Manioc', province: 'Kongo Central', priceUsd: 0.32, updatedAt: now },
    { commodity: 'Maïs',   province: 'Kongo Central', priceUsd: 0.22, updatedAt: now },
  ]
  for (const doc of samples) {
    const id = `${doc.commodity}_${doc.province}`.replace(/[\s']/g, '_')
    await db.collection('province_prices').doc(id).set(doc, { merge: true })
    console.log(`✓ province_prices/${id}`)
  }

  console.log('\nSeed complete.')
  process.exit(0)
}

seed().catch(err => { console.error(err); process.exit(1) })
