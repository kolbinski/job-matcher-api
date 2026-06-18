import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const languageNames: Record<string, Record<string, string>> = {
  en: { English: 'English', Polish: 'Polish', German: 'German', French: 'French', Spanish: 'Spanish', Italian: 'Italian', Portuguese: 'Portuguese', Russian: 'Russian', Ukrainian: 'Ukrainian', Dutch: 'Dutch', Swedish: 'Swedish', Norwegian: 'Norwegian', Danish: 'Danish', Finnish: 'Finnish', Czech: 'Czech', Slovak: 'Slovak', Hungarian: 'Hungarian', Romanian: 'Romanian', Turkish: 'Turkish', Arabic: 'Arabic', Hebrew: 'Hebrew', Chinese: 'Chinese', Japanese: 'Japanese', Korean: 'Korean', Hindi: 'Hindi' },
  pl: { English: 'Angielski', Polish: 'Polski', German: 'Niemiecki', French: 'Francuski', Spanish: 'Hiszpański', Italian: 'Włoski', Portuguese: 'Portugalski', Russian: 'Rosyjski', Ukrainian: 'Ukraiński', Dutch: 'Holenderski', Swedish: 'Szwedzki', Norwegian: 'Norweski', Danish: 'Duński', Finnish: 'Fiński', Czech: 'Czeski', Slovak: 'Słowacki', Hungarian: 'Węgierski', Romanian: 'Rumuński', Turkish: 'Turecki', Arabic: 'Arabski', Hebrew: 'Hebrajski', Chinese: 'Chiński', Japanese: 'Japoński', Korean: 'Koreański', Hindi: 'Hindi' },
  de: { English: 'Englisch', Polish: 'Polnisch', German: 'Deutsch', French: 'Französisch', Spanish: 'Spanisch', Italian: 'Italienisch', Portuguese: 'Portugiesisch', Russian: 'Russisch', Ukrainian: 'Ukrainisch', Dutch: 'Niederländisch', Swedish: 'Schwedisch', Norwegian: 'Norwegisch', Danish: 'Dänisch', Finnish: 'Finnisch', Czech: 'Tschechisch', Slovak: 'Slowakisch', Hungarian: 'Ungarisch', Romanian: 'Rumänisch', Turkish: 'Türkisch', Arabic: 'Arabisch', Hebrew: 'Hebräisch', Chinese: 'Chinesisch', Japanese: 'Japanisch', Korean: 'Koreanisch', Hindi: 'Hindi' },
  fr: { English: 'Anglais', Polish: 'Polonais', German: 'Allemand', French: 'Français', Spanish: 'Espagnol', Italian: 'Italien', Portuguese: 'Portugais', Russian: 'Russe', Ukrainian: 'Ukrainien', Dutch: 'Néerlandais', Swedish: 'Suédois', Norwegian: 'Norvégien', Danish: 'Danois', Finnish: 'Finnois', Czech: 'Tchèque', Slovak: 'Slovaque', Hungarian: 'Hongrois', Romanian: 'Roumain', Turkish: 'Turc', Arabic: 'Arabe', Hebrew: 'Hébreu', Chinese: 'Chinois', Japanese: 'Japonais', Korean: 'Coréen', Hindi: 'Hindi' },
  es: { English: 'Inglés', Polish: 'Polaco', German: 'Alemán', French: 'Francés', Spanish: 'Español', Italian: 'Italiano', Portuguese: 'Portugués', Russian: 'Ruso', Ukrainian: 'Ucraniano', Dutch: 'Holandés', Swedish: 'Sueco', Norwegian: 'Noruego', Danish: 'Danés', Finnish: 'Finlandés', Czech: 'Checo', Slovak: 'Eslovaco', Hungarian: 'Húngaro', Romanian: 'Rumano', Turkish: 'Turco', Arabic: 'Árabe', Hebrew: 'Hebreo', Chinese: 'Chino', Japanese: 'Japonés', Korean: 'Coreano', Hindi: 'Hindi' },
  it: { English: 'Inglese', Polish: 'Polacco', German: 'Tedesco', French: 'Francese', Spanish: 'Spagnolo', Italian: 'Italiano', Portuguese: 'Portoghese', Russian: 'Russo', Ukrainian: 'Ucraino', Dutch: 'Olandese', Swedish: 'Svedese', Norwegian: 'Norvegese', Danish: 'Danese', Finnish: 'Finlandese', Czech: 'Ceco', Slovak: 'Slovacco', Hungarian: 'Ungherese', Romanian: 'Rumeno', Turkish: 'Turco', Arabic: 'Arabo', Hebrew: 'Ebraico', Chinese: 'Cinese', Japanese: 'Giapponese', Korean: 'Coreano', Hindi: 'Hindi' },
  pt: { English: 'Inglês', Polish: 'Polonês', German: 'Alemão', French: 'Francês', Spanish: 'Espanhol', Italian: 'Italiano', Portuguese: 'Português', Russian: 'Russo', Ukrainian: 'Ucraniano', Dutch: 'Holandês', Swedish: 'Sueco', Norwegian: 'Norueguês', Danish: 'Dinamarquês', Finnish: 'Finlandês', Czech: 'Tcheco', Slovak: 'Eslovaco', Hungarian: 'Húngaro', Romanian: 'Romeno', Turkish: 'Turco', Arabic: 'Árabe', Hebrew: 'Hebraico', Chinese: 'Chinês', Japanese: 'Japonês', Korean: 'Coreano', Hindi: 'Hindi' },
  ru: { English: 'Английский', Polish: 'Польский', German: 'Немецкий', French: 'Французский', Spanish: 'Испанский', Italian: 'Итальянский', Portuguese: 'Португальский', Russian: 'Русский', Ukrainian: 'Украинский', Dutch: 'Нидерландский', Swedish: 'Шведский', Norwegian: 'Норвежский', Danish: 'Датский', Finnish: 'Финский', Czech: 'Чешский', Slovak: 'Словацкий', Hungarian: 'Венгерский', Romanian: 'Румынский', Turkish: 'Турецкий', Arabic: 'Арабский', Hebrew: 'Иврит', Chinese: 'Китайский', Japanese: 'Японский', Korean: 'Корейский', Hindi: 'Хинди' },
  uk: { English: 'Англійська', Polish: 'Польська', German: 'Німецька', French: 'Французька', Spanish: 'Іспанська', Italian: 'Італійська', Portuguese: 'Португальська', Russian: 'Російська', Ukrainian: 'Українська', Dutch: 'Нідерландська', Swedish: 'Шведська', Norwegian: 'Норвезька', Danish: 'Данська', Finnish: 'Фінська', Czech: 'Чеська', Slovak: 'Словацька', Hungarian: 'Угорська', Romanian: 'Румунська', Turkish: 'Турецька', Arabic: 'Арабська', Hebrew: 'Іврит', Chinese: 'Китайська', Japanese: 'Японська', Korean: 'Корейська', Hindi: 'Гінді' },
  nl: { English: 'Engels', Polish: 'Pools', German: 'Duits', French: 'Frans', Spanish: 'Spaans', Italian: 'Italiaans', Portuguese: 'Portugees', Russian: 'Russisch', Ukrainian: 'Oekraïens', Dutch: 'Nederlands', Swedish: 'Zweeds', Norwegian: 'Noors', Danish: 'Deens', Finnish: 'Fins', Czech: 'Tsjechisch', Slovak: 'Slowaaks', Hungarian: 'Hongaars', Romanian: 'Roemeens', Turkish: 'Turks', Arabic: 'Arabisch', Hebrew: 'Hebreeuws', Chinese: 'Chinees', Japanese: 'Japans', Korean: 'Koreaans', Hindi: 'Hindi' },
  sv: { English: 'Engelska', Polish: 'Polska', German: 'Tyska', French: 'Franska', Spanish: 'Spanska', Italian: 'Italienska', Portuguese: 'Portugisiska', Russian: 'Ryska', Ukrainian: 'Ukrainska', Dutch: 'Nederländska', Swedish: 'Svenska', Norwegian: 'Norska', Danish: 'Danska', Finnish: 'Finska', Czech: 'Tjeckiska', Slovak: 'Slovakiska', Hungarian: 'Ungerska', Romanian: 'Rumänska', Turkish: 'Turkiska', Arabic: 'Arabiska', Hebrew: 'Hebreiska', Chinese: 'Kinesiska', Japanese: 'Japanska', Korean: 'Koreanska', Hindi: 'Hindi' },
  no: { English: 'Engelsk', Polish: 'Polsk', German: 'Tysk', French: 'Fransk', Spanish: 'Spansk', Italian: 'Italiensk', Portuguese: 'Portugisisk', Russian: 'Russisk', Ukrainian: 'Ukrainsk', Dutch: 'Nederlandsk', Swedish: 'Svensk', Norwegian: 'Norsk', Danish: 'Dansk', Finnish: 'Finsk', Czech: 'Tsjekkisk', Slovak: 'Slovakisk', Hungarian: 'Ungarsk', Romanian: 'Rumensk', Turkish: 'Tyrkisk', Arabic: 'Arabisk', Hebrew: 'Hebraisk', Chinese: 'Kinesisk', Japanese: 'Japansk', Korean: 'Koreansk', Hindi: 'Hindi' },
  da: { English: 'Engelsk', Polish: 'Polsk', German: 'Tysk', French: 'Fransk', Spanish: 'Spansk', Italian: 'Italiensk', Portuguese: 'Portugisisk', Russian: 'Russisk', Ukrainian: 'Ukrainsk', Dutch: 'Nederlandsk', Swedish: 'Svensk', Norwegian: 'Norsk', Danish: 'Dansk', Finnish: 'Finsk', Czech: 'Tjekkisk', Slovak: 'Slovakisk', Hungarian: 'Ungarsk', Romanian: 'Rumænsk', Turkish: 'Tyrkisk', Arabic: 'Arabisk', Hebrew: 'Hebraisk', Chinese: 'Kinesisk', Japanese: 'Japansk', Korean: 'Koreansk', Hindi: 'Hindi' },
  fi: { English: 'Englanti', Polish: 'Puola', German: 'Saksa', French: 'Ranska', Spanish: 'Espanja', Italian: 'Italia', Portuguese: 'Portugali', Russian: 'Venäjä', Ukrainian: 'Ukraina', Dutch: 'Hollanti', Swedish: 'Ruotsi', Norwegian: 'Norja', Danish: 'Tanska', Finnish: 'Suomi', Czech: 'Tšekki', Slovak: 'Slovakia', Hungarian: 'Unkari', Romanian: 'Romania', Turkish: 'Turkki', Arabic: 'Arabia', Hebrew: 'Heprea', Chinese: 'Kiina', Japanese: 'Japani', Korean: 'Korea', Hindi: 'Hindi' },
  cs: { English: 'Angličtina', Polish: 'Polština', German: 'Němčina', French: 'Francouzština', Spanish: 'Španělština', Italian: 'Italština', Portuguese: 'Portugalština', Russian: 'Ruština', Ukrainian: 'Ukrajinština', Dutch: 'Nizozemština', Swedish: 'Švédština', Norwegian: 'Norština', Danish: 'Dánština', Finnish: 'Finština', Czech: 'Čeština', Slovak: 'Slovenština', Hungarian: 'Maďarština', Romanian: 'Rumunština', Turkish: 'Turečtina', Arabic: 'Arabština', Hebrew: 'Hebrejština', Chinese: 'Čínština', Japanese: 'Japonština', Korean: 'Korejština', Hindi: 'Hindština' },
  sk: { English: 'Angličtina', Polish: 'Poľština', German: 'Nemčina', French: 'Francúzština', Spanish: 'Španielčina', Italian: 'Taliančina', Portuguese: 'Portugalčina', Russian: 'Ruština', Ukrainian: 'Ukrajinčina', Dutch: 'Holandčina', Swedish: 'Švédčina', Norwegian: 'Nórčina', Danish: 'Dánčina', Finnish: 'Fínčina', Czech: 'Čeština', Slovak: 'Slovenčina', Hungarian: 'Maďarčina', Romanian: 'Rumunčina', Turkish: 'Turečtina', Arabic: 'Arabčina', Hebrew: 'Hebrejčina', Chinese: 'Čínština', Japanese: 'Japončina', Korean: 'Kórejčina', Hindi: 'Hindčina' },
  hu: { English: 'Angol', Polish: 'Lengyel', German: 'Német', French: 'Francia', Spanish: 'Spanyol', Italian: 'Olasz', Portuguese: 'Portugál', Russian: 'Orosz', Ukrainian: 'Ukrán', Dutch: 'Holland', Swedish: 'Svéd', Norwegian: 'Norvég', Danish: 'Dán', Finnish: 'Finn', Czech: 'Cseh', Slovak: 'Szlovák', Hungarian: 'Magyar', Romanian: 'Román', Turkish: 'Török', Arabic: 'Arab', Hebrew: 'Héber', Chinese: 'Kínai', Japanese: 'Japán', Korean: 'Koreai', Hindi: 'Hindi' },
  ro: { English: 'Engleză', Polish: 'Poloneză', German: 'Germană', French: 'Franceză', Spanish: 'Spaniolă', Italian: 'Italiană', Portuguese: 'Portugheză', Russian: 'Rusă', Ukrainian: 'Ucraineană', Dutch: 'Olandeză', Swedish: 'Suedeză', Norwegian: 'Norvegiană', Danish: 'Daneză', Finnish: 'Finlandeză', Czech: 'Cehă', Slovak: 'Slovacă', Hungarian: 'Maghiară', Romanian: 'Română', Turkish: 'Turcă', Arabic: 'Arabă', Hebrew: 'Ebraică', Chinese: 'Chineză', Japanese: 'Japoneză', Korean: 'Coreeană', Hindi: 'Hindi' },
  tr: { English: 'İngilizce', Polish: 'Lehçe', German: 'Almanca', French: 'Fransızca', Spanish: 'İspanyolca', Italian: 'İtalyanca', Portuguese: 'Portekizce', Russian: 'Rusça', Ukrainian: 'Ukraynaca', Dutch: 'Hollandaca', Swedish: 'İsveççe', Norwegian: 'Norveççe', Danish: 'Danimarkaca', Finnish: 'Fince', Czech: 'Çekçe', Slovak: 'Slovakça', Hungarian: 'Macarca', Romanian: 'Romence', Turkish: 'Türkçe', Arabic: 'Arapça', Hebrew: 'İbranice', Chinese: 'Çince', Japanese: 'Japonca', Korean: 'Korece', Hindi: 'Hintçe' },
  ar: { English: 'الإنجليزية', Polish: 'البولندية', German: 'الألمانية', French: 'الفرنسية', Spanish: 'الإسبانية', Italian: 'الإيطالية', Portuguese: 'البرتغالية', Russian: 'الروسية', Ukrainian: 'الأوكرانية', Dutch: 'الهولندية', Swedish: 'السويدية', Norwegian: 'النرويجية', Danish: 'الدنماركية', Finnish: 'الفنلندية', Czech: 'التشيكية', Slovak: 'السلوفاكية', Hungarian: 'الهنغارية', Romanian: 'الرومانية', Turkish: 'التركية', Arabic: 'العربية', Hebrew: 'العبرية', Chinese: 'الصينية', Japanese: 'اليابانية', Korean: 'الكورية', Hindi: 'الهندية' },
  he: { English: 'אנגלית', Polish: 'פולנית', German: 'גרמנית', French: 'צרפתית', Spanish: 'ספרדית', Italian: 'איטלקית', Portuguese: 'פורטוגזית', Russian: 'רוסית', Ukrainian: 'אוקראינית', Dutch: 'הולנדית', Swedish: 'שוודית', Norwegian: 'נורווגית', Danish: 'דנית', Finnish: 'פינית', Czech: 'צ׳כית', Slovak: 'סלובקית', Hungarian: 'הונגרית', Romanian: 'רומנית', Turkish: 'טורקית', Arabic: 'ערבית', Hebrew: 'עברית', Chinese: 'סינית', Japanese: 'יפנית', Korean: 'קורנית', Hindi: 'הינדי' },
  zh: { English: '英语', Polish: '波兰语', German: '德语', French: '法语', Spanish: '西班牙语', Italian: '意大利语', Portuguese: '葡萄牙语', Russian: '俄语', Ukrainian: '乌克兰语', Dutch: '荷兰语', Swedish: '瑞典语', Norwegian: '挪威语', Danish: '丹麦语', Finnish: '芬兰语', Czech: '捷克语', Slovak: '斯洛伐克语', Hungarian: '匈牙利语', Romanian: '罗马尼亚语', Turkish: '土耳其语', Arabic: '阿拉伯语', Hebrew: '希伯来语', Chinese: '中文', Japanese: '日语', Korean: '韩语', Hindi: '印地语' },
  ja: { English: '英語', Polish: 'ポーランド語', German: 'ドイツ語', French: 'フランス語', Spanish: 'スペイン語', Italian: 'イタリア語', Portuguese: 'ポルトガル語', Russian: 'ロシア語', Ukrainian: 'ウクライナ語', Dutch: 'オランダ語', Swedish: 'スウェーデン語', Norwegian: 'ノルウェー語', Danish: 'デンマーク語', Finnish: 'フィンランド語', Czech: 'チェコ語', Slovak: 'スロバキア語', Hungarian: 'ハンガリー語', Romanian: 'ルーマニア語', Turkish: 'トルコ語', Arabic: 'アラビア語', Hebrew: 'ヘブライ語', Chinese: '中国語', Japanese: '日本語', Korean: '韓国語', Hindi: 'ヒンディー語' },
  ko: { English: '영어', Polish: '폴란드어', German: '독일어', French: '프랑스어', Spanish: '스페인어', Italian: '이탈리아어', Portuguese: '포르투갈어', Russian: '러시아어', Ukrainian: '우크라이나어', Dutch: '네덜란드어', Swedish: '스웨덴어', Norwegian: '노르웨이어', Danish: '덴마크어', Finnish: '핀란드어', Czech: '체코어', Slovak: '슬로바키아어', Hungarian: '헝가리어', Romanian: '루마니아어', Turkish: '터키어', Arabic: '아랍어', Hebrew: '히브리어', Chinese: '중국어', Japanese: '일본어', Korean: '한국어', Hindi: '힌디어' },
  hi: { English: 'अंग्रेज़ी', Polish: 'पोलिश', German: 'जर्मन', French: 'फ्रेंच', Spanish: 'स्पेनिश', Italian: 'इतालवी', Portuguese: 'पुर्तगाली', Russian: 'रूसी', Ukrainian: 'यूक्रेनी', Dutch: 'डच', Swedish: 'स्वीडिश', Norwegian: 'नॉर्वेजियन', Danish: 'डेनिश', Finnish: 'फिनिश', Czech: 'चेक', Slovak: 'स्लोवाक', Hungarian: 'हंगेरियन', Romanian: 'रोमानियाई', Turkish: 'तुर्की', Arabic: 'अरबी', Hebrew: 'हिब्रू', Chinese: 'चीनी', Japanese: 'जापानी', Korean: 'कोरियाई', Hindi: 'हिंदी' },
}

interface LangEntry {
  code: string
  name: string
  language_names?: Record<string, string>
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
    language_names: languageNames[l.code] ?? {},
  }))

  parsed.languages = updated

  await prisma.settings.update({
    where: { key: 'general_settings' },
    data: { value: JSON.stringify(parsed) },
  })

  console.log(`Updated ${updated.length} language entries with language_names field`)
  updated.forEach(l =>
    console.log(`  ${l.code} → ${Object.keys(l.language_names ?? {}).length} names`),
  )
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
