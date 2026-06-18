import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

interface CvLabels {
  summary: string
  experience: string
  own_projects: string
  skills: string
  highlighted: string
  education: string
  languages: string
  certifications: string
}

const CV_LABELS_MAP: Record<string, CvLabels> = {
  en: { summary: 'Summary', experience: 'Experience', own_projects: 'Own Projects', skills: 'Skills', highlighted: 'Highlighted for this Role', education: 'Education', languages: 'Languages', certifications: 'Certifications' },
  pl: { summary: 'Podsumowanie', experience: 'Doświadczenie', own_projects: 'Projekty własne', skills: 'Umiejętności', highlighted: 'Kluczowe dla tej roli', education: 'Wykształcenie', languages: 'Języki', certifications: 'Certyfikaty' },
  de: { summary: 'Zusammenfassung', experience: 'Berufserfahrung', own_projects: 'Eigene Projekte', skills: 'Fähigkeiten', highlighted: 'Hervorgehoben für diese Rolle', education: 'Ausbildung', languages: 'Sprachen', certifications: 'Zertifikate' },
  fr: { summary: 'Résumé', experience: 'Expérience', own_projects: 'Projets personnels', skills: 'Compétences', highlighted: 'Points clés pour ce poste', education: 'Formation', languages: 'Langues', certifications: 'Certifications' },
  es: { summary: 'Resumen', experience: 'Experiencia', own_projects: 'Proyectos propios', skills: 'Habilidades', highlighted: 'Destacado para este puesto', education: 'Educación', languages: 'Idiomas', certifications: 'Certificaciones' },
  it: { summary: 'Sommario', experience: 'Esperienza', own_projects: 'Progetti personali', skills: 'Competenze', highlighted: 'In evidenza per questo ruolo', education: 'Istruzione', languages: 'Lingue', certifications: 'Certificazioni' },
  pt: { summary: 'Resumo', experience: 'Experiência', own_projects: 'Projetos próprios', skills: 'Competências', highlighted: 'Destacado para esta função', education: 'Educação', languages: 'Idiomas', certifications: 'Certificações' },
  ru: { summary: 'Резюме', experience: 'Опыт работы', own_projects: 'Собственные проекты', skills: 'Навыки', highlighted: 'Выделено для этой роли', education: 'Образование', languages: 'Языки', certifications: 'Сертификаты' },
  uk: { summary: 'Резюме', experience: 'Досвід роботи', own_projects: 'Власні проекти', skills: 'Навички', highlighted: 'Виділено для цієї ролі', education: 'Освіта', languages: 'Мови', certifications: 'Сертифікати' },
  nl: { summary: 'Samenvatting', experience: 'Ervaring', own_projects: 'Eigen projecten', skills: 'Vaardigheden', highlighted: 'Uitgelicht voor deze rol', education: 'Opleiding', languages: 'Talen', certifications: 'Certificaten' },
  sv: { summary: 'Sammanfattning', experience: 'Erfarenhet', own_projects: 'Egna projekt', skills: 'Färdigheter', highlighted: 'Framhävt för denna roll', education: 'Utbildning', languages: 'Språk', certifications: 'Certifieringar' },
  no: { summary: 'Sammendrag', experience: 'Erfaring', own_projects: 'Egne prosjekter', skills: 'Ferdigheter', highlighted: 'Fremhevet for denne rollen', education: 'Utdanning', languages: 'Språk', certifications: 'Sertifiseringer' },
  da: { summary: 'Resumé', experience: 'Erfaring', own_projects: 'Egne projekter', skills: 'Færdigheder', highlighted: 'Fremhævet til denne rolle', education: 'Uddannelse', languages: 'Sprog', certifications: 'Certifikater' },
  fi: { summary: 'Yhteenveto', experience: 'Kokemus', own_projects: 'Omat projektit', skills: 'Taidot', highlighted: 'Korostettu tähän rooliin', education: 'Koulutus', languages: 'Kielet', certifications: 'Sertifikaatit' },
  cs: { summary: 'Shrnutí', experience: 'Zkušenosti', own_projects: 'Vlastní projekty', skills: 'Dovednosti', highlighted: 'Zdůrazněno pro tuto roli', education: 'Vzdělání', languages: 'Jazyky', certifications: 'Certifikáty' },
  sk: { summary: 'Zhrnutie', experience: 'Skúsenosti', own_projects: 'Vlastné projekty', skills: 'Zručnosti', highlighted: 'Zvýraznené pre túto rolu', education: 'Vzdelanie', languages: 'Jazyky', certifications: 'Certifikáty' },
  hu: { summary: 'Összefoglalás', experience: 'Tapasztalat', own_projects: 'Saját projektek', skills: 'Készségek', highlighted: 'Kiemelve ehhez a szerephez', education: 'Végzettség', languages: 'Nyelvek', certifications: 'Tanúsítványok' },
  ro: { summary: 'Rezumat', experience: 'Experiență', own_projects: 'Proiecte proprii', skills: 'Abilități', highlighted: 'Evidențiat pentru acest rol', education: 'Educație', languages: 'Limbi', certifications: 'Certificări' },
  tr: { summary: 'Özet', experience: 'Deneyim', own_projects: 'Kişisel Projeler', skills: 'Beceriler', highlighted: 'Bu rol için öne çıkarıldı', education: 'Eğitim', languages: 'Diller', certifications: 'Sertifikalar' },
  ar: { summary: 'ملخص', experience: 'الخبرة', own_projects: 'المشاريع الخاصة', skills: 'المهارات', highlighted: 'مميز لهذا الدور', education: 'التعليم', languages: 'اللغات', certifications: 'الشهادات' },
  he: { summary: 'סיכום', experience: 'ניסיון', own_projects: 'פרויקטים אישיים', skills: 'כישורים', highlighted: 'מודגש לתפקיד זה', education: 'השכלה', languages: 'שפות', certifications: 'הסמכות' },
  zh: { summary: '简介', experience: '工作经验', own_projects: '个人项目', skills: '技能', highlighted: '针对此职位的亮点', education: '教育背景', languages: '语言', certifications: '证书' },
  ja: { summary: '概要', experience: '職務経験', own_projects: '個人プロジェクト', skills: 'スキル', highlighted: 'このポジションのハイライト', education: '学歴', languages: '言語', certifications: '資格' },
  ko: { summary: '요약', experience: '경력', own_projects: '개인 프로젝트', skills: '기술', highlighted: '이 역할을 위한 하이라이트', education: '학력', languages: '언어', certifications: '자격증' },
  hi: { summary: 'सारांश', experience: 'अनुभव', own_projects: 'व्यक्तिगत परियोजनाएं', skills: 'कौशल', highlighted: 'इस भूमिका के लिए हाइलाइट', education: 'शिक्षा', languages: 'भाषाएं', certifications: 'प्रमाणपत्र' },
}

interface LangEntry {
  code: string
  name: string
  locale?: string
  gdpr?: string
  best_regards?: string
  cv_labels?: CvLabels
  [key: string]: unknown
}

async function main() {
  const row = await prisma.settings.findUnique({ where: { key: 'general_settings' } })
  if (!row) {
    console.error('general_settings row not found')
    process.exit(1)
  }

  const parsed = JSON.parse(row.value) as Record<string, unknown>
  const languages = (parsed.languages ?? []) as LangEntry[]

  const updated = languages.map(l => ({
    ...l,
    cv_labels: l.cv_labels ?? CV_LABELS_MAP[l.code] ?? CV_LABELS_MAP.en,
  }))

  parsed.languages = updated

  await prisma.settings.update({
    where: { key: 'general_settings' },
    data: { value: JSON.stringify(parsed) },
  })

  console.log(`Updated ${updated.length} language entries with cv_labels field`)
  updated.forEach(l => console.log(`  ${l.code} → ${CV_LABELS_MAP[l.code] ? 'mapped' : 'fallback(en)'}`))
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
