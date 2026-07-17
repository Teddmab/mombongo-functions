import { db } from '../lib/admin'
import { FieldValue } from 'firebase-admin/firestore'

const farmers = [
  {
    name: 'Jean-Baptiste Kalonji',
    region: 'Kasaï Central',
    cropType: 'Maïs',
    farmSizeHa: 5.2,
    requestedAmountUsd: 800,
    disbursedAmountUsd: 0,
    status: 'approved',
    agentId: null,
    nextHarvestDate: new Date('2026-09-15'),
    photoUrl: '',
    createdAt: FieldValue.serverTimestamp(),
  },
  {
    name: 'Marie Ngalula',
    region: 'Bandundu',
    cropType: 'Manioc',
    farmSizeHa: 3.0,
    requestedAmountUsd: 500,
    disbursedAmountUsd: 250,
    status: 'active',
    agentId: null,
    nextHarvestDate: new Date('2026-08-01'),
    photoUrl: '',
    createdAt: FieldValue.serverTimestamp(),
  },
  {
    name: 'Pierre Mukendi',
    region: 'Katanga',
    cropType: 'Soja',
    farmSizeHa: 8.0,
    requestedAmountUsd: 1200,
    disbursedAmountUsd: 0,
    status: 'approved',
    agentId: null,
    nextHarvestDate: new Date('2026-10-20'),
    photoUrl: '',
    createdAt: FieldValue.serverTimestamp(),
  },
  {
    name: 'Coopérative Kivu Arabica',
    region: 'Nord-Kivu',
    cropType: 'Café Arabica',
    farmSizeHa: 40,
    requestedAmountUsd: 12000,
    disbursedAmountUsd: 9800,
    status: 'active',
    agentId: null,
    nextHarvestDate: new Date('2026-11-01'),
    photoUrl: '',
    createdAt: FieldValue.serverTimestamp(),
  },
]

const culturalEvents = [
  { cropType: 'Maïs', eventType: 'planting', monthStart: 10, monthEnd: 11, description: 'Semis de maïs — début saison sèche' },
  { cropType: 'Maïs', eventType: 'harvest', monthStart: 3, monthEnd: 4, description: 'Récolte maïs' },
  { cropType: 'Manioc', eventType: 'planting', monthStart: 9, monthEnd: 10, description: 'Bouturage manioc' },
  { cropType: 'Manioc', eventType: 'harvest', monthStart: 9, monthEnd: 12, description: 'Récolte manioc — 12 mois après semis' },
  { cropType: 'Soja', eventType: 'planting', monthStart: 4, monthEnd: 5, description: 'Semis soja grande saison' },
  { cropType: 'Soja', eventType: 'harvest', monthStart: 8, monthEnd: 9, description: 'Récolte soja' },
  { cropType: 'Cacao', eventType: 'harvest', monthStart: 10, monthEnd: 2, description: 'Grande récolte cacao (Oct – Fév)' },
  { cropType: 'Café Arabica', eventType: 'harvest', monthStart: 10, monthEnd: 2, description: 'Récolte café Arabica (Oct – Fév)' },
]

async function seed() {
  const batch = db.batch()
  for (const f of farmers) batch.set(db.collection('farmers').doc(), f)
  for (const e of culturalEvents) batch.set(db.collection('cultural_events').doc(), e)
  await batch.commit()
  console.log(`Financing seeded: ${farmers.length} farmers, ${culturalEvents.length} cultural events ✓`)
}

seed().catch(console.error)
