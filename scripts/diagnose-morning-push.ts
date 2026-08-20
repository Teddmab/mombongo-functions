/**
 * Diagnostic + dry-run for the morning price push pipeline.
 * Run from mombongo-functions/:
 *   npx ts-node --project tsconfig.json scripts/diagnose-morning-push.ts
 */
import * as admin from 'firebase-admin'

if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'mombongo-dev' })
}

const db = admin.firestore()

// Statuses that mean the crop is done / cancelled — exclude from push targeting
const EXCLUDED_STATUSES = new Set(['termine', 'annule'])

async function run() {
  console.log('\n══════════════════════════════════════════════════════')
  console.log('  Morning Push Diagnostic')
  console.log('══════════════════════════════════════════════════════\n')

  // ── 1. Current (broken) logic ──────────────────────────────────────────────
  console.log('── 1. Current CF logic (reads users.cropType + users.province) ──')
  const farmersSnap = await db.collection('users').where('role', '==', 'farmer').get()
  const withFields = farmersSnap.docs.filter(d => d.data().cropType && d.data().province).length
  console.log(`   ${farmersSnap.size} farmers found, ${withFields} have cropType+province → would send to ${withFields}\n`)

  // ── 2. FCM token status ────────────────────────────────────────────────────
  console.log('── 2. FCM token registration ──')
  for (const doc of farmersSnap.docs) {
    const d = doc.data()
    const count = Array.isArray(d.fcmTokens) ? d.fcmTokens.length : 0
    const legacy = d.fcmToken ? 1 : 0
    const total = count + legacy
    const mark = total > 0 ? '✓' : '✗'
    console.log(`   ${mark}  ${doc.id.slice(0, 12)}…  tokens: ${total} (array: ${count}, legacy: ${legacy})`)
  }
  console.log()

  // ── 3. Corrected logic: read from exploitations + cultures ─────────────────
  console.log('── 3. Corrected logic (exploitations + cultures, skip terminated) ──')
  const explSnap = await db.collection('exploitations').get()
  console.log(`   ${explSnap.size} exploitation(s) found`)

  const groups = new Map<string, { commodity: string; province: string; farmerUids: Set<string> }>()
  const optedOut = new Set<string>()

  // Pre-fetch user notification prefs
  const userPrefs = new Map<string, boolean>()
  for (const doc of farmersSnap.docs) {
    const prefs = doc.data().notificationPrefs as Record<string, unknown> | undefined
    if (prefs?.morningPrice === false) userPrefs.set(doc.id, false)
  }

  for (const expl of explSnap.docs) {
    const e = expl.data()
    const farmerId: string = e.farmerId ?? ''
    const province: string = e.province ?? ''
    if (!farmerId || !province) {
      console.log(`   skip ${expl.id}: missing farmerId or province`)
      continue
    }
    if (userPrefs.get(farmerId) === false) {
      optedOut.add(farmerId)
      continue
    }

    const cultSnap = await db.collection('exploitations').doc(expl.id).collection('cultures').get()
    let counted = 0
    for (const cult of cultSnap.docs) {
      const c = cult.data()
      const commodity: string = c.commodity ?? ''
      const status: string = c.status ?? 'active'
      if (!commodity || EXCLUDED_STATUSES.has(status)) continue
      const key = `${commodity}::${province}`
      if (!groups.has(key)) groups.set(key, { commodity, province, farmerUids: new Set() })
      groups.get(key)!.farmerUids.add(farmerId)
      counted++
    }
    console.log(`   exploitation ${expl.id.slice(0, 12)}…  farmerId=${farmerId.slice(0, 12)}…  province=${province}  eligible cultures=${counted}`)
  }

  if (optedOut.size > 0) console.log(`   ${optedOut.size} farmer(s) opted out of morning push`)
  console.log()

  // ── 4. Groups summary ──────────────────────────────────────────────────────
  console.log('── 4. Groups the corrected CF would form ──')
  if (groups.size === 0) {
    console.log('   (none)\n')
  } else {
    for (const [, g] of groups) {
      const tokens = [...g.farmerUids].reduce((sum, uid) => {
        const doc = farmersSnap.docs.find(d => d.id === uid)
        const arr = Array.isArray(doc?.data().fcmTokens) ? doc!.data().fcmTokens.length : 0
        const single = doc?.data().fcmToken ? 1 : 0
        return sum + arr + single
      }, 0)
      console.log(`   ${g.commodity} / ${g.province}  →  ${g.farmerUids.size} farmer(s), ${tokens} FCM token(s)`)
    }
    console.log()
  }

  // ── 5. province_prices coverage ────────────────────────────────────────────
  console.log('── 5. province_prices coverage ──')
  if (groups.size === 0) {
    console.log('   (no groups)\n')
  } else {
    for (const [, g] of groups) {
      const snap = await db.collection('province_prices')
        .where('commodity', '==', g.commodity)
        .where('province', '==', g.province)
        .orderBy('updatedAt', 'desc')
        .limit(1)
        .get()
      if (snap.empty) {
        console.log(`   ✗  ${g.commodity} / ${g.province}  →  no province_prices doc`)
      } else {
        const d = snap.docs[0].data()
        console.log(`   ✓  ${g.commodity} / ${g.province}  →  priceUsd=${d.priceUsd ?? '?'}`)
      }
    }
    console.log()
  }

  // ── 6. config/exchange_rate ────────────────────────────────────────────────
  const rateSnap = await db.collection('config').doc('exchange_rate').get()
  console.log(`── 6. config/exchange_rate: ${rateSnap.exists ? `usdToCdf=${rateSnap.data()!.usdToCdf} ✓` : 'MISSING ✗'}\n`)

  // ── Summary ────────────────────────────────────────────────────────────────
  const totalTokens = farmersSnap.docs.reduce((s, d) => {
    return s + (Array.isArray(d.data().fcmTokens) ? d.data().fcmTokens.length : 0) + (d.data().fcmToken ? 1 : 0)
  }, 0)

  console.log('══════════════════════════════════════════════════════')
  console.log('  What needs to happen for push to work')
  console.log('══════════════════════════════════════════════════════')
  console.log(`  [${withFields > 0 ? '✓' : '✗'}] users have cropType+province   : ${withFields}/${farmersSnap.size}  (fix: change CF to read from exploitations)`)
  console.log(`  [${groups.size > 0 ? '✓' : '✗'}] groups formed (corrected)     : ${groups.size}`)
  console.log(`  [${totalTokens > 0 ? '✓' : '✗'}] FCM tokens registered         : ${totalTokens} total  (fix: grant permission in web app + check VITE_FIREBASE_VAPID_KEY)`)
  const pricesMissing = groups.size > 0 ? (await Promise.all([...groups.values()].map(async g => {
    const s = await db.collection('province_prices').where('commodity', '==', g.commodity).where('province', '==', g.province).limit(1).get()
    return s.empty
  }))).filter(Boolean).length : 0
  console.log(`  [${pricesMissing === 0 && groups.size > 0 ? '✓' : '✗'}] province_prices docs present   : ${groups.size - pricesMissing}/${groups.size} groups covered`)
  console.log()
}

run().catch(err => { console.error(err); process.exit(1) })
