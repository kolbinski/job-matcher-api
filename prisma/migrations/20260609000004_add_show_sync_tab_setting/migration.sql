INSERT INTO settings (id, key, value, updated_at)
VALUES (gen_random_uuid(), 'show_sync_tab_in_extension', 'true', now())
ON CONFLICT (key) DO NOTHING;
