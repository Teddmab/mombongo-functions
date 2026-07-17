import { db } from '../lib/admin'
import { FieldValue } from 'firebase-admin/firestore'

const opportunities = [
  {
    title: 'Transport Tomates Matadi → Kinshasa',
    type: 'transport',
    origin: 'Matadi',
    destination: 'Kinshasa',
    volume: '120 bacs',
    price: '75,000 FC',
    commission: 20,
    duration: '5 jours',
    spotsLeft: 3,
    spotsTotal: 8,
    status: 'open',
    targetCdf: 9_800_000,
    minInvestCdf: 10_000,
    capacityKg: 2000,
    filledKg: 0,
    investorsCount: 0,
    departureDate: new Date('2026-08-15'),
    createdAt: FieldValue.serverTimestamp(),
  },
  {
    title: 'Stockage Manioc Kinshasa',
    type: 'stockage',
    origin: 'Kinshasa',
    destination: 'Kinshasa',
    volume: '200 sacs',
    price: '40,000 FC',
    commission: 12,
    duration: '30 jours',
    spotsLeft: 6,
    spotsTotal: 10,
    status: 'open',
    targetCdf: 5_400_000,
    minInvestCdf: 10_000,
    capacityKg: 5000,
    filledKg: 0,
    investorsCount: 0,
    departureDate: new Date('2026-08-20'),
    createdAt: FieldValue.serverTimestamp(),
  },
  {
    title: 'Transformation Café Kivu',
    type: 'transformation',
    origin: 'Goma',
    destination: 'Goma',
    volume: '500 kg',
    price: '$1,200',
    commission: 28,
    duration: '21 jours',
    spotsLeft: 2,
    spotsTotal: 5,
    status: 'open',
    targetCdf: 3_000_000,
    minInvestCdf: 10_000,
    capacityKg: 500,
    filledKg: 0,
    investorsCount: 0,
    departureDate: new Date('2026-08-18'),
    createdAt: FieldValue.serverTimestamp(),
  },
]

const prices = [
  { symbol: 'TOM-MAT', productName: 'Tomates Matadi', price: '1,250 FC/kg', change: 2.4, recordedAt: FieldValue.serverTimestamp() },
  { symbol: 'PAST-SGL', productName: 'Pastèques Songololo', price: '850 FC/kg', change: -1.1, recordedAt: FieldValue.serverTimestamp() },
  { symbol: 'CAF-KIV', productName: 'Café Kivu', price: '$4.20/lb', change: 3.8, recordedAt: FieldValue.serverTimestamp() },
  { symbol: 'CAC-BC', productName: 'Cacao Bas-Congo', price: '$3.10/kg', change: 1.6, recordedAt: FieldValue.serverTimestamp() },
  { symbol: 'MAN-KIN', productName: 'Manioc Kinshasa', price: '320 FC/kg', change: 0.5, recordedAt: FieldValue.serverTimestamp() },
  { symbol: 'OIG-KIN', productName: 'Oignons Kinshasa', price: '1,800 FC/kg', change: -0.7, recordedAt: FieldValue.serverTimestamp() },
]

async function seed() {
  const batch = db.batch()
  for (const o of opportunities) batch.set(db.collection('bourse_opportunities').doc(), o)
  for (const p of prices) batch.set(db.collection('bourse_prices').doc(), p)
  await batch.commit()
  console.log(`Bourse seeded: ${opportunities.length} opportunities, ${prices.length} prices ✓`)
}

seed().catch(console.error)
