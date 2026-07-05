/**
 * Seeds one active investment product into Firestore.
 * Run: npx ts-node -r tsconfig-paths/register scripts/seed-product.ts
 *   or: npx tsx scripts/seed-product.ts
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS or firebase-admin default creds.
 */
import * as admin from 'firebase-admin'

if (!admin.apps.length) admin.initializeApp()

const db = admin.firestore()

async function seed() {
  const product = {
    name: 'Pastèques Songololo',
    icon: '🍉',
    category: 'agriculture',
    location: 'Songololo, Kongo Central',
    farmer: 'Jean-Baptiste Mwamba',
    description:
      'Culture de pastèques biologiques sur 5 hectares fertiles à Songololo. ' +
      'Marché principal : Kinshasa. Suivi hebdomadaire par agent terrain.',
    roi: 22,
    minInvest: 50,
    duration: 45,
    stock: 180,
    unit: 'bacs',
    targetUsd: 5000,
    invested: 0,
    investorsCount: 0,
    status: 'active',
    createdBy: 'seed-script',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }

  const ref = await db.collection('products').add(product)
  console.log(`✅ Product created: ${ref.id}`)
  console.log(`   Name     : ${product.name}`)
  console.log(`   ROI      : ${product.roi}%`)
  console.log(`   Min invest: $${product.minInvest}`)
  console.log(`   Duration : ${product.duration} days`)
  console.log(`   Status   : ${product.status}`)
  process.exit(0)
}

seed().catch(err => { console.error(err); process.exit(1) })
