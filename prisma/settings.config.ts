export const SETTINGS = [
  { key: 'work_start_utc',           value: '6' },
  { key: 'work_end_utc',             value: '15' },
  { key: 'work_days',                value: '1-5' },
  { key: 'ai_scoring_enabled',       value: 'true' },
  { key: 'fetch_offers_after_build', value: 'false' },
  { key: 'justjoin_max_pages',       value: '3' },
  { key: 'nfj_max_pages',            value: '3' },
  { key: 'delete_reasons',           value: '["Found a job on my own","Found a job through Homo Digital","Too expensive","Not enough job matches","CV/CL quality not good enough","Missing features I need","Switching to a different service","Taking a break from job search","Privacy concerns","Technical issues","Other"]' },
] as const
