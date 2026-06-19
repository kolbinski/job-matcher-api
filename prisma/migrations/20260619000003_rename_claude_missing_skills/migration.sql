-- Rename claude_missing_skills to missing_skills on user_offers
ALTER TABLE "user_offers" RENAME COLUMN "claude_missing_skills" TO "missing_skills";
