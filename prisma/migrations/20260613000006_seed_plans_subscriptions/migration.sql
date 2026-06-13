INSERT INTO "plans" (id, name, limits, features, is_active, created_at)
VALUES
  (gen_random_uuid(), 'free',    '{"max_apply_now":10,"max_level_up":20}'::jsonb,       '{}'::jsonb, true, now()),
  (gen_random_uuid(), 'pro',     '{"max_apply_now":null,"max_level_up":null}'::jsonb,    '{}'::jsonb, true, now()),
  (gen_random_uuid(), 'premium', '{"max_apply_now":null,"max_level_up":null}'::jsonb,    '{}'::jsonb, true, now())
ON CONFLICT (name) DO NOTHING;

INSERT INTO "subscriptions" (id, user_id, plan_id, status, created_at, updated_at)
SELECT gen_random_uuid(), u.id, p.id, 'active', now(), now()
FROM "users" u
CROSS JOIN "plans" p
WHERE p.name = 'free'
  AND NOT EXISTS (SELECT 1 FROM "subscriptions" s WHERE s.user_id = u.id);
