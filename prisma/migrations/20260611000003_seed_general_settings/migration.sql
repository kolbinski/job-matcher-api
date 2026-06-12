INSERT INTO "settings" ("id", "key", "value", "updated_at")
VALUES (
  gen_random_uuid(),
  'general_settings',
  '{
  "currencies": ["USD","PLN","EUR","GBP","CHF","NOK","SEK","DKK","CAD","AUD"],
  "industries": ["fintech","saas","developer_tools","proptech","e-commerce","healthcare","edtech","gaming","media","travel","logistics","cybersecurity","ai_ml","blockchain","martech"],
  "markets": ["Poland","Europe","USA","UK","Germany","Netherlands","Scandinavia","remote_global"],
  "company_types": ["product","startup","outsourcing","body_leasing","agency","consultancy","corporation"],
  "countries": [
    {"code":"pl","name":"Poland"},{"code":"de","name":"Germany"},{"code":"gb","name":"United Kingdom"},
    {"code":"us","name":"United States"},{"code":"nl","name":"Netherlands"},{"code":"fr","name":"France"},
    {"code":"se","name":"Sweden"},{"code":"no","name":"Norway"},{"code":"dk","name":"Denmark"},
    {"code":"fi","name":"Finland"},{"code":"ch","name":"Switzerland"},{"code":"at","name":"Austria"},
    {"code":"be","name":"Belgium"},{"code":"cz","name":"Czech Republic"},{"code":"sk","name":"Slovakia"},
    {"code":"hu","name":"Hungary"},{"code":"ro","name":"Romania"},{"code":"ua","name":"Ukraine"},
    {"code":"ru","name":"Russia"},{"code":"es","name":"Spain"},{"code":"it","name":"Italy"},
    {"code":"pt","name":"Portugal"},{"code":"ie","name":"Ireland"},{"code":"ca","name":"Canada"},
    {"code":"au","name":"Australia"},{"code":"nz","name":"New Zealand"},{"code":"il","name":"Israel"},
    {"code":"tr","name":"Turkey"},{"code":"ae","name":"UAE"},{"code":"sg","name":"Singapore"},
    {"code":"in","name":"India"},{"code":"jp","name":"Japan"},{"code":"kr","name":"South Korea"},
    {"code":"cn","name":"China"},{"code":"br","name":"Brazil"},{"code":"mx","name":"Mexico"}
  ],
  "languages": ["English","Polish","German","French","Spanish","Italian","Portuguese","Russian","Ukrainian","Dutch","Swedish","Norwegian","Danish","Finnish","Czech","Slovak","Hungarian","Romanian","Turkish","Arabic","Hebrew","Chinese","Japanese","Korean","Hindi"],
  "language_levels": ["native","fluent","professional","conversational","basic","C2","C1","B2","B1","A2","A1"],
  "experience_levels": ["junior","mid","senior","lead","principal","staff","architect","c_level"]
}',
  NOW()
)
ON CONFLICT ("key") DO NOTHING;
