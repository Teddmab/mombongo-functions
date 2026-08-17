import { db, functions } from '../lib/admin'

export const getWarehouses = functions
  .region('europe-west1')
  .https.onCall(async (data) => {
    const { province, commodity } = (data ?? {}) as { province?: string; commodity?: string }

    const snap = await db.collection('warehouses').where('isActive', '==', true).get()
    let warehouses = snap.docs.map(d => ({ id: d.id, ...d.data() })) as any[]

    if (province) warehouses = warehouses.filter((w: any) => w.province === province)
    if (commodity) warehouses = warehouses.filter((w: any) =>
      w.commoditiesAccepted?.includes(commodity) || w.commoditiesAccepted?.includes('tous')
    )

    return { warehouses }
  })
