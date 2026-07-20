import { db } from '../lib/admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'

const listings = [
  {
    sellerId: 'seed-farmer-1',
    sellerName: 'Jean Mukeba',
    sellerRole: 'farmer',
    commodity: 'Maïs',
    quantityKg: 20_000,
    quality: 'B',
    province: 'Bandundu',
    territory: 'Kikwit',
    pricePerKgCdf: 400,
    availableFrom: Timestamp.fromDate(new Date('2026-07-20')),
    availableUntil: Timestamp.fromDate(new Date('2026-09-01')),
    photoUrls: [],
    status: 'active',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  },
  {
    sellerId: 'seed-farmer-2',
    sellerName: 'Coopérative Kivu Vert',
    sellerRole: 'cooperative',
    commodity: 'Haricot',
    quantityKg: 5_000,
    quality: 'A',
    province: 'Sud-Kivu',
    territory: 'Uvira',
    pricePerKgCdf: 1_200,
    availableFrom: Timestamp.fromDate(new Date('2026-08-01')),
    availableUntil: Timestamp.fromDate(new Date('2026-10-01')),
    photoUrls: [],
    status: 'active',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  },
  {
    sellerId: 'seed-farmer-3',
    sellerName: 'Ambroise Kalenga',
    sellerRole: 'farmer',
    commodity: 'Cacao',
    quantityKg: 3_000,
    quality: 'A',
    province: 'Équateur',
    territory: 'Mbandaka',
    pricePerKgCdf: 4_800,
    availableFrom: Timestamp.fromDate(new Date('2026-07-25')),
    availableUntil: Timestamp.fromDate(new Date('2026-08-31')),
    photoUrls: [],
    status: 'active',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  },
  {
    sellerId: 'seed-farmer-4',
    sellerName: 'Marie Luzolo',
    sellerRole: 'farmer',
    commodity: 'Manioc',
    quantityKg: 50_000,
    quality: 'B',
    province: 'Kongo-Central',
    territory: 'Mbanza-Ngungu',
    pricePerKgCdf: 580,
    availableFrom: Timestamp.fromDate(new Date('2026-07-20')),
    availableUntil: Timestamp.fromDate(new Date('2026-08-20')),
    photoUrls: [],
    status: 'active',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  },
  {
    sellerId: 'seed-farmer-5',
    sellerName: 'Coopérative Maniema',
    sellerRole: 'cooperative',
    commodity: 'Riz',
    quantityKg: 12_000,
    quality: 'A',
    province: 'Maniema',
    territory: 'Kindu',
    pricePerKgCdf: 1_050,
    availableFrom: Timestamp.fromDate(new Date('2026-08-10')),
    availableUntil: Timestamp.fromDate(new Date('2026-09-30')),
    photoUrls: [],
    status: 'active',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  },
]

const buyerOrders = [
  {
    buyerId: 'seed-merchant-1',
    buyerName: 'Minoterie Fraîcheur SARL',
    buyerRole: 'processor',
    commodity: 'Maïs',
    quantityKg: 15_000,
    maxPricePerKgCdf: 420,
    deliveryProvince: 'Kinshasa',
    neededBy: Timestamp.fromDate(new Date('2026-08-15')),
    status: 'open',
    createdAt: FieldValue.serverTimestamp(),
  },
  {
    buyerId: 'seed-merchant-2',
    buyerName: 'Café Export Congo',
    buyerRole: 'exporter',
    commodity: 'Cacao',
    quantityKg: 2_000,
    maxPricePerKgCdf: 5_000,
    deliveryProvince: 'Kinshasa',
    neededBy: Timestamp.fromDate(new Date('2026-09-01')),
    status: 'open',
    createdAt: FieldValue.serverTimestamp(),
  },
  {
    buyerId: 'seed-merchant-3',
    buyerName: 'BRALIMA Distribution',
    buyerRole: 'processor',
    commodity: 'Maïs',
    quantityKg: 30_000,
    maxPricePerKgCdf: 410,
    deliveryProvince: 'Kinshasa',
    neededBy: Timestamp.fromDate(new Date('2026-09-15')),
    status: 'open',
    createdAt: FieldValue.serverTimestamp(),
  },
  {
    buyerId: 'seed-merchant-4',
    buyerName: 'Supermarché Kin Plaza',
    buyerRole: 'merchant',
    commodity: 'Haricot',
    quantityKg: 2_000,
    maxPricePerKgCdf: 1_250,
    deliveryProvince: 'Kinshasa',
    neededBy: Timestamp.fromDate(new Date('2026-08-20')),
    status: 'open',
    createdAt: FieldValue.serverTimestamp(),
  },
]

const prices = [
  { commodity: 'Maïs',    province: 'Kinshasa',     priceCdfPerKg: 430,   previousPriceCdfPerKg: 415, volumeKgTraded: 45_000 },
  { commodity: 'Maïs',    province: 'Bandundu',      priceCdfPerKg: 395,   previousPriceCdfPerKg: 400, volumeKgTraded: 28_000 },
  { commodity: 'Maïs',    province: 'Kongo-Central', priceCdfPerKg: 405,   previousPriceCdfPerKg: 400, volumeKgTraded: 18_000 },
  { commodity: 'Manioc',  province: 'Kinshasa',      priceCdfPerKg: 620,   previousPriceCdfPerKg: 600, volumeKgTraded: 80_000 },
  { commodity: 'Manioc',  province: 'Kongo-Central', priceCdfPerKg: 580,   previousPriceCdfPerKg: 575, volumeKgTraded: 32_000 },
  { commodity: 'Cacao',   province: 'Équateur',      priceCdfPerKg: 4_800, previousPriceCdfPerKg: 4_600, volumeKgTraded: 8_000 },
  { commodity: 'Haricot', province: 'Sud-Kivu',      priceCdfPerKg: 1_180, previousPriceCdfPerKg: 1_150, volumeKgTraded: 12_000 },
  { commodity: 'Haricot', province: 'Kinshasa',      priceCdfPerKg: 1_250, previousPriceCdfPerKg: 1_220, volumeKgTraded: 9_000 },
  { commodity: 'Riz',     province: 'Maniema',       priceCdfPerKg: 1_050, previousPriceCdfPerKg: 1_080, volumeKgTraded: 15_000 },
  { commodity: 'Riz',     province: 'Kinshasa',      priceCdfPerKg: 1_100, previousPriceCdfPerKg: 1_090, volumeKgTraded: 22_000 },
]

async function seed() {
  const batch = db.batch()
  const today = new Date().toISOString().split('T')[0]

  for (const l of listings) batch.set(db.collection('product_listings').doc(), l)
  for (const o of buyerOrders) batch.set(db.collection('buyer_orders').doc(), o)
  for (const p of prices) {
    batch.set(db.collection('bourse_prices_by_province').doc(), {
      ...p,
      recordedDate: today,
      recordedAt: FieldValue.serverTimestamp(),
    })
  }

  await batch.commit()
  console.log(`Agro Exchange seeded: ${listings.length} listings, ${buyerOrders.length} orders, ${prices.length} price points`)
}

seed().catch(console.error)
