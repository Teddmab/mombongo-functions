import { db, functions } from '../lib/admin'

export const getTransportPartners = functions
  .region('europe-west1')
  .https.onCall(async (data) => {
    const { province, commodity } = (data ?? {}) as { province?: string; commodity?: string }

    const snap = await db.collection('transport_partners').where('isActive', '==', true).get()
    let partners = snap.docs.map(d => ({ id: d.id, ...d.data() })) as any[]

    if (province) partners = partners.filter((p: any) =>
      p.coverageProvinces?.includes(province) || p.coverageProvinces?.includes('tous')
    )
    if (commodity) partners = partners.filter((p: any) =>
      p.commodities?.includes(commodity) || p.commodities?.includes('tous')
    )

    return { partners }
  })
