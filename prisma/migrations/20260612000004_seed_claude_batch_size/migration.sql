INSERT INTO "settings" ("id", "key", "value", "updated_at")
VALUES (gen_random_uuid(), 'claude_batch_size', '25', NOW())
ON CONFLICT ("key") DO UPDATE SET "value" = '25';
