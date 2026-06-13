UPDATE "settings"
SET value = (value::jsonb || '{"show_source_filter": false}'::jsonb)::text
WHERE key = 'general_settings';
