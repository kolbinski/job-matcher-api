-- AlterTable
ALTER TABLE "skills" ADD COLUMN "was_categorized" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: treat existing skills with a real (non-catch-all) category as already categorized.
UPDATE "skills"
SET "was_categorized" = true
WHERE "category_id" IS NOT NULL
  AND "category_id" NOT IN (
    SELECT "id" FROM "skill_categories" WHERE "name" IN ('Other IT', 'other')
  );
