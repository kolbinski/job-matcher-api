-- Add profile_path to users
ALTER TABLE "users" ADD COLUMN "profile_path" TEXT;

-- Create user_offers table
CREATE TABLE "user_offers" (
    "id"                       TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "user_id"                  TEXT         NOT NULL,
    "offer_id"                 TEXT         NOT NULL,
    "status"                   TEXT         NOT NULL,
    "rejection_reason"         TEXT,
    "claude_score"             INTEGER,
    "claude_role_fit"          TEXT,
    "claude_matched_reasons"   TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "claude_missing_skills"    TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "claude_salary_comparison" TEXT,
    "claude_recommended"       BOOLEAN,
    "matched_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"               TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_offers_pkey" PRIMARY KEY ("id")
);

-- Foreign keys
ALTER TABLE "user_offers" ADD CONSTRAINT "user_offers_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_offers" ADD CONSTRAINT "user_offers_offer_id_fkey"
    FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One record per user per offer
CREATE UNIQUE INDEX "user_offers_user_id_offer_id_key" ON "user_offers"("user_id", "offer_id");

-- Index for pipeline and dedup queries
CREATE INDEX "user_offers_user_id_idx" ON "user_offers"("user_id");

-- Seed profile_path for the test user
UPDATE "users"
SET    "profile_path" = 'src/data/marek-wisniewski-profile.json'
WHERE  "jobmatcher_api_key" = 'jm_test_homodigital123456789012';
