export const SETTINGS = [
  { key: 'cronjob_interval_minutes', value: '15' },
  { key: 'cronjob_schedule',         value: '45 6 * * 1-5|0 7-15 * * 1-5' },
  { key: 'work_start_utc',           value: '6' },
  { key: 'work_end_utc',             value: '15' },
  { key: 'work_days',                value: '1-5' },
  { key: 'ai_scoring_enabled',       value: 'true' },
  { key: 'max_pages',                value: '3' },
] as const
