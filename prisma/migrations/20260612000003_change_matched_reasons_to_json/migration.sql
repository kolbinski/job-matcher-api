ALTER TABLE "user_offers" ALTER COLUMN "claude_matched_reasons" TYPE JSONB USING '{"pros":[],"cons":[]}'::JSONB;

UPDATE "user_offers" SET "claude_matched_reasons" = '{"pros":[],"cons":[]}'::JSONB WHERE "claude_matched_reasons" IS NOT NULL;
