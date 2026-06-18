import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const translations: Record<string, Record<string, string>> = {
  '96466e4d-cbc2-405d-ae4d-1baf0aab435a': { en: 'AI & Data', pl: 'AI i Dane', de: 'KI & Daten', fr: 'IA & Données', es: 'IA y Datos', it: 'IA & Dati', pt: 'IA & Dados', ru: 'ИИ и Данные', uk: 'ШІ та Дані', nl: 'AI & Data', sv: 'AI & Data', no: 'AI & Data', da: 'AI & Data', fi: 'AI & Data', cs: 'AI a Data', sk: 'AI a Dáta', hu: 'AI & Adatok', ro: 'AI & Date', tr: 'AI & Veri', ar: 'الذكاء الاصطناعي والبيانات', he: 'בינה מלאכותית ונתונים', zh: 'AI与数据', ja: 'AI・データ', ko: 'AI & 데이터', hi: 'AI और डेटा' },
  'b43ea739-fe17-41ef-8f7a-48a5944a5a87': { en: 'Backend', pl: 'Backend', de: 'Backend', fr: 'Backend', es: 'Backend', it: 'Backend', pt: 'Backend', ru: 'Бэкенд', uk: 'Бекенд', nl: 'Backend', sv: 'Backend', no: 'Backend', da: 'Backend', fi: 'Backend', cs: 'Backend', sk: 'Backend', hu: 'Backend', ro: 'Backend', tr: 'Backend', ar: 'الخلفية', he: 'בקאנד', zh: '后端', ja: 'バックエンド', ko: '백엔드', hi: 'बैकएंड' },
  '5b1abd85-992d-44f1-b710-b117e36c5289': { en: 'Cloud & Infra', pl: 'Chmura i Infrastruktura', de: 'Cloud & Infrastruktur', fr: 'Cloud & Infrastructure', es: 'Nube & Infraestructura', it: 'Cloud & Infrastruttura', pt: 'Nuvem & Infraestrutura', ru: 'Облако и Инфраструктура', uk: 'Хмара та Інфраструктура', nl: 'Cloud & Infra', sv: 'Moln & Infrastruktur', no: 'Sky & Infrastruktur', da: 'Sky & Infrastruktur', fi: 'Pilvi & Infrastruktuuri', cs: 'Cloud & Infrastruktura', sk: 'Cloud & Infraštruktúra', hu: 'Felhő & Infrastruktúra', ro: 'Cloud & Infrastructură', tr: 'Bulut & Altyapı', ar: 'السحابة والبنية التحتية', he: 'ענן ותשתיות', zh: '云计算与基础设施', ja: 'クラウド・インフラ', ko: '클라우드 & 인프라', hi: 'क्लाउड और इंफ्रा' },
  '536fc1b8-e107-40e0-83de-29a6ef8aa3a2': { en: 'Databases', pl: 'Bazy danych', de: 'Datenbanken', fr: 'Bases de données', es: 'Bases de datos', it: 'Database', pt: 'Bases de dados', ru: 'Базы данных', uk: 'Бази даних', nl: 'Databases', sv: 'Databaser', no: 'Databaser', da: 'Databaser', fi: 'Tietokannat', cs: 'Databáze', sk: 'Databázy', hu: 'Adatbázisok', ro: 'Baze de date', tr: 'Veritabanları', ar: 'قواعد البيانات', he: 'מסדי נתונים', zh: '数据库', ja: 'データベース', ko: '데이터베이스', hi: 'डेटाबेस' },
  '461c0bbd-6ada-4ff3-a0c2-620f5270e03a': { en: 'Frontend', pl: 'Frontend', de: 'Frontend', fr: 'Frontend', es: 'Frontend', it: 'Frontend', pt: 'Frontend', ru: 'Фронтенд', uk: 'Фронтенд', nl: 'Frontend', sv: 'Frontend', no: 'Frontend', da: 'Frontend', fi: 'Frontend', cs: 'Frontend', sk: 'Frontend', hu: 'Frontend', ro: 'Frontend', tr: 'Frontend', ar: 'الواجهة الأمامية', he: 'פרונטאנד', zh: '前端', ja: 'フロントエンド', ko: '프론트엔드', hi: 'फ्रंटएंड' },
  '6418742f-ee74-4666-bc62-e8df773bfde7': { en: 'Languages', pl: 'Języki programowania', de: 'Programmiersprachen', fr: 'Langages de programmation', es: 'Lenguajes de programación', it: 'Linguaggi di programmazione', pt: 'Linguagens de programação', ru: 'Языки программирования', uk: 'Мови програмування', nl: 'Programmeertalen', sv: 'Programmeringsspråk', no: 'Programmeringsspråk', da: 'Programmeringssprog', fi: 'Ohjelmointikielet', cs: 'Programovací jazyky', sk: 'Programovacie jazyky', hu: 'Programozási nyelvek', ro: 'Limbaje de programare', tr: 'Programlama Dilleri', ar: 'لغات البرمجة', he: 'שפות תכנות', zh: '编程语言', ja: 'プログラミング言語', ko: '프로그래밍 언어', hi: 'प्रोग्रामिंग भाषाएं' },
  '9724b46f-c240-4234-9222-8eedebbbc430': { en: 'Methodology', pl: 'Metodologia', de: 'Methodik', fr: 'Méthodologie', es: 'Metodología', it: 'Metodologia', pt: 'Metodologia', ru: 'Методология', uk: 'Методологія', nl: 'Methodologie', sv: 'Metodik', no: 'Metodikk', da: 'Metodik', fi: 'Metodologia', cs: 'Metodologie', sk: 'Metodológia', hu: 'Módszertan', ro: 'Metodologie', tr: 'Metodoloji', ar: 'المنهجية', he: 'מתודולוגיה', zh: '方法论', ja: '方法論', ko: '방법론', hi: 'कार्यप्रणाली' },
  '107c39cc-3517-4e9c-a14b-768b0720195d': { en: 'Mobile', pl: 'Mobile', de: 'Mobile', fr: 'Mobile', es: 'Móvil', it: 'Mobile', pt: 'Mobile', ru: 'Мобильная разработка', uk: 'Мобільна розробка', nl: 'Mobiel', sv: 'Mobil', no: 'Mobil', da: 'Mobil', fi: 'Mobiili', cs: 'Mobilní', sk: 'Mobilné', hu: 'Mobil', ro: 'Mobile', tr: 'Mobil', ar: 'الجوال', he: 'מובייל', zh: '移动端', ja: 'モバイル', ko: '모바일', hi: 'मोबाइल' },
  '3ff9ac62-281a-4501-967f-8f2c4f41d460': { en: 'Other', pl: 'Inne', de: 'Sonstiges', fr: 'Autres', es: 'Otros', it: 'Altro', pt: 'Outros', ru: 'Другое', uk: 'Інше', nl: 'Overig', sv: 'Övrigt', no: 'Annet', da: 'Andet', fi: 'Muut', cs: 'Ostatní', sk: 'Ostatné', hu: 'Egyéb', ro: 'Altele', tr: 'Diğer', ar: 'أخرى', he: 'אחר', zh: '其他', ja: 'その他', ko: '기타', hi: 'अन्य' },
  '2f5a9095-36df-4113-915d-f3ad7a50305b': { en: 'Other IT', pl: 'Inne IT', de: 'Sonstiges IT', fr: 'Autre IT', es: 'Otro IT', it: 'Altro IT', pt: 'Outro IT', ru: 'Прочее IT', uk: 'Інше IT', nl: 'Overig IT', sv: 'Övrigt IT', no: 'Annet IT', da: 'Andet IT', fi: 'Muu IT', cs: 'Ostatní IT', sk: 'Ostatné IT', hu: 'Egyéb IT', ro: 'Alt IT', tr: 'Diğer IT', ar: 'تقنية المعلومات الأخرى', he: 'IT אחר', zh: '其他IT', ja: 'その他IT', ko: '기타 IT', hi: 'अन्य IT' },
  '570567ca-7c36-4749-b9ed-bae1c6a6dbfe': { en: 'Security', pl: 'Bezpieczeństwo', de: 'Sicherheit', fr: 'Sécurité', es: 'Seguridad', it: 'Sicurezza', pt: 'Segurança', ru: 'Безопасность', uk: 'Безпека', nl: 'Beveiliging', sv: 'Säkerhet', no: 'Sikkerhet', da: 'Sikkerhed', fi: 'Tietoturva', cs: 'Bezpečnost', sk: 'Bezpečnosť', hu: 'Biztonság', ro: 'Securitate', tr: 'Güvenlik', ar: 'الأمن', he: 'אבטחה', zh: '安全', ja: 'セキュリティ', ko: '보안', hi: 'सुरक्षा' },
  'cffe52a6-07f2-460e-9883-a90e9cb84abf': { en: 'Testing', pl: 'Testowanie', de: 'Testen', fr: 'Tests', es: 'Pruebas', it: 'Testing', pt: 'Testes', ru: 'Тестирование', uk: 'Тестування', nl: 'Testen', sv: 'Testning', no: 'Testing', da: 'Test', fi: 'Testaus', cs: 'Testování', sk: 'Testovanie', hu: 'Tesztelés', ro: 'Testare', tr: 'Test', ar: 'الاختبار', he: 'בדיקות', zh: '测试', ja: 'テスト', ko: '테스팅', hi: 'परीक्षण' },
  '8da5533d-b642-4194-b752-657266ab2341': { en: 'Tools', pl: 'Narzędzia', de: 'Werkzeuge', fr: 'Outils', es: 'Herramientas', it: 'Strumenti', pt: 'Ferramentas', ru: 'Инструменты', uk: 'Інструменти', nl: 'Tools', sv: 'Verktyg', no: 'Verktøy', da: 'Værktøjer', fi: 'Työkalut', cs: 'Nástroje', sk: 'Nástroje', hu: 'Eszközök', ro: 'Instrumente', tr: 'Araçlar', ar: 'الأدوات', he: 'כלים', zh: '工具', ja: 'ツール', ko: '도구', hi: 'उपकरण' },
}

async function main() {
  const ids = Object.keys(translations)
  let updated = 0
  for (const id of ids) {
    try {
      await prisma.skillCategory.update({
        where: { id },
        data: { translations: translations[id] },
      })
      updated++
      console.log(`  ${id} → ${translations[id].en}`)
    } catch (err) {
      console.error(`  FAILED ${id}:`, err instanceof Error ? err.message : err)
    }
  }
  console.log(`Updated ${updated}/${ids.length} skill categories with translations`)
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
