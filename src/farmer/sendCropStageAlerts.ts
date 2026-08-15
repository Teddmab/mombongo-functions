import { admin, functions } from '../lib/admin'
import { sendPush } from '../notifications/sendPush'

const db = admin.firestore()

const CULTURE_STAGES = ['Semis', 'Germination', 'Croissance', 'Floraison', 'Fructification', 'Récolte']

const CROP_STAGE_TIPS: Record<string, Partial<Record<string, string>>> = {
  Manioc: {
    Semis:          "Plantez les boutures à 1m × 1m d'espacement, nœuds vers le haut",
    Germination:    "Démariage: conservez 1 plant par poquet. Désherbez légèrement",
    Croissance:     "Désherbez autour des plants — évitez la compétition racinaire",
    Floraison:      "Supprimez les fleurs pour favoriser la tubérisation",
    Fructification: "Arrêtez tout désherbage — les feuilles protègent le sol",
    Récolte:        "Récoltez 9–18 mois après plantation selon la variété",
  },
  Maïs: {
    Semis:          "Semez à 25 cm entre plants, 75 cm entre rangs. Profondeur 3–5 cm",
    Germination:    "Démariage à 2 plants/poquet à J+10. Sarclage léger",
    Croissance:     "Buttage: ramener la terre vers la base. Application urée 1ère dose",
    Floraison:      "Stade critique: appliquez engrais azoté (urée) maintenant",
    Fructification: "Arrêtez irrigation — laissez sécher sur pied 2 semaines",
    Récolte:        "Récoltez quand les grains sonnent creux à la pression",
  },
  Café: {
    Croissance:     "Taille de formation: sélectionnez 1–3 tiges principales",
    Fructification: "Défoltiation partielle pour aérer et faciliter la maturation",
    Récolte:        "Récoltez cerises rouges uniquement — tri à 100%",
  },
  Cacao: {
    Croissance:     "Taille des gourmands et drageons. Maintenir ombrage léger",
    Fructification: "Surveillance cabosse brune (pourriture brune). Traitez si >10%",
    Récolte:        "Fermentation 5–7 jours sous sacs jute, retournez 2×/jour",
  },
  Riz: {
    Semis:          "Repiquez à 20 × 20 cm. Niveau d'eau 5 cm les 2 premières semaines",
    Croissance:     "Maintenir 5–10 cm d'eau. Application engrais NPK",
    Floraison:      "Phase critique: ne pas assécher. Surveiller pyriculariose",
    Récolte:        "Fauchez quand 85% des grains sont dorés",
  },
  Haricot: {
    Semis:          "Semez à 30 cm entre plants. Évitez excès d'eau à la levée",
    Floraison:      "Évitez tout stress hydrique — irriguer si nécessaire",
    Récolte:        "Récoltez gousses à pleine maturité, tiges sèches",
  },
}

function getStageIndex(moisSemis: number, currentMonth: number): number {
  const monthsGrown = (currentMonth - moisSemis + 12) % 12
  return Math.min(Math.floor(monthsGrown), CULTURE_STAGES.length - 1)
}

export const sendCropStageAlerts = functions
  .region('europe-west1')
  .pubsub.schedule('0 7 * * *')
  .timeZone('Africa/Kinshasa')
  .onRun(async () => {
    const now = new Date()
    const today = now.getDate()
    const currentMonth = now.getMonth() + 1

    // Only send on 1st of month (stage transition day)
    if (today !== 1) return null

    const snap = await db.collection('cultures')
      .where('status', '==', 'active')
      .get()

    let sent = 0
    const tasks: Promise<void>[] = []

    for (const doc of snap.docs) {
      const culture = doc.data()
      const { farmerId, commodity, moisSemis } = culture
      if (!farmerId || !commodity || !moisSemis) continue

      const stageIdx = getStageIndex(moisSemis as number, currentMonth)
      const stage = CULTURE_STAGES[stageIdx]
      const tip = CROP_STAGE_TIPS[commodity as string]?.[stage]

      if (!tip) continue

      tasks.push(
        sendPush(
          farmerId as string,
          `🌱 ${commodity} — ${stage}`,
          tip,
          { cultureId: doc.id, stage, type: 'crop_stage_tip' }
        ).then(() => { sent++ }).catch(() => undefined)
      )
    }

    await Promise.all(tasks)
    functions.logger.info(`sendCropStageAlerts: sent ${sent} tips for ${currentMonth}/1`)
    return null
  })
