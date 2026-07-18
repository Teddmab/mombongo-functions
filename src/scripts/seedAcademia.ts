import * as admin from 'firebase-admin'

if (!admin.apps.length) admin.initializeApp()
const db = admin.firestore()

const courses = [
  {
    title: 'Agriculture durable au Congo',
    titleEn: 'Sustainable Agriculture in Congo',
    description: 'Maîtrisez les techniques modernes pour maximiser vos rendements de façon écologique.',
    category: 'agriculture',
    level: 'beginner',
    durationMinutes: 90,
    moduleCount: 4,
    thumbnail: '',
    instructor: 'Dr. Olivier Mwamba',
    isFeatured: true,
    enrollmentCount: 0,
    status: 'published',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  },
  {
    title: 'Gestion financière pour agriculteurs',
    titleEn: 'Financial Management for Farmers',
    description: 'Apprenez à gérer votre budget, accéder aux financements et planifier votre saison.',
    category: 'finance',
    level: 'intermediate',
    durationMinutes: 120,
    moduleCount: 5,
    thumbnail: '',
    instructor: 'Prof. Alice Kabila',
    isFeatured: true,
    enrollmentCount: 0,
    status: 'published',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  },
  {
    title: 'Commerce et export des produits agricoles',
    titleEn: 'Trade and Export of Agricultural Products',
    description: 'Comment vendre vos produits sur les marchés nationaux et internationaux.',
    category: 'commerce',
    level: 'advanced',
    durationMinutes: 150,
    moduleCount: 6,
    thumbnail: '',
    instructor: 'Emmanuel Luyindula',
    isFeatured: false,
    enrollmentCount: 0,
    status: 'published',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  },
]

const modulesByCourseIndex: Array<Array<object>> = [
  [
    { order: 1, title: "Introduction à l'agriculture régénérative", type: 'video', youtubeVideoId: 'dQw4w9WgXcQ', durationMinutes: 18, isFree: true },
    { order: 2, title: "Gestion de l'eau et irrigation", type: 'video', youtubeVideoId: 'dQw4w9WgXcQ', durationMinutes: 22, isFree: false },
    { order: 3, title: 'Guide de compostage — PDF', type: 'pdf', pdfUrl: '', durationMinutes: 15, isFree: false },
    { order: 4, title: 'Quiz — Agriculture durable', type: 'quiz', durationMinutes: 10, isFree: false,
      questions: [
        { q: 'Quel engrais naturel améliore la structure du sol ?', options: ['Urée', 'Compost', 'DAP', 'NPK'], answer: 1 },
      ],
    },
  ],
  [
    { order: 1, title: 'Introduction à la gestion agricole', type: 'video', youtubeVideoId: 'dQw4w9WgXcQ', durationMinutes: 20, isFree: true },
    { order: 2, title: 'Trésorerie et budget de saison', type: 'video', youtubeVideoId: 'dQw4w9WgXcQ', durationMinutes: 25, isFree: false },
    { order: 3, title: 'Calculer le ROI agricole', type: 'video', youtubeVideoId: 'dQw4w9WgXcQ', durationMinutes: 20, isFree: false },
    { order: 4, title: 'Accéder aux financements Mombongo', type: 'pdf', pdfUrl: '', durationMinutes: 15, isFree: false },
    { order: 5, title: 'Quiz — Gestion financière', type: 'quiz', durationMinutes: 10, isFree: false,
      questions: [
        { q: "Un budget prévisionnel vous permet de :", options: ["Calculer vos impôts", "Anticiper dépenses et recettes", "Choisir vos cultures", "Fixer vos prix"], answer: 1 },
      ],
    },
  ],
  [
    { order: 1, title: 'Les marchés nationaux et régionaux', type: 'video', youtubeVideoId: 'dQw4w9WgXcQ', durationMinutes: 30, isFree: true },
    { order: 2, title: 'Procédures douanières export RDC', type: 'video', youtubeVideoId: 'dQw4w9WgXcQ', durationMinutes: 28, isFree: false },
    { order: 3, title: 'Normes qualité et certifications', type: 'pdf', pdfUrl: '', durationMinutes: 20, isFree: false },
  ],
]

async function seed() {
  for (let i = 0; i < courses.length; i++) {
    const ref = await db.collection('courses').add(courses[i])
    const mods = modulesByCourseIndex[i] ?? []
    for (const mod of mods) {
      await db.collection('courses').doc(ref.id).collection('modules').add({
        ...(mod as object),
        courseId: ref.id,
      })
    }
    console.log(`Seeded course: ${courses[i].title} (${ref.id}) with ${mods.length} modules`)
  }
  console.log('Academia seed complete')
}

seed().catch(err => { console.error(err); process.exit(1) })
