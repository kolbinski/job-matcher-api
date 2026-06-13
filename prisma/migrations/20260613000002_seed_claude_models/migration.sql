INSERT INTO settings (id, key, value, updated_at)
VALUES (gen_random_uuid(), 'claude_models', '{"prepare_profile":"claude-sonnet-4-6","review_profile":"claude-sonnet-4-6","cv_cl_generation":"claude-sonnet-4-6","matching":"claude-sonnet-4-6"}', now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
