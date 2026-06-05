-- DropIndex
DROP INDEX "user_offers_user_id_idx";

-- AlterTable
ALTER TABLE "offers" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "user_offers" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "claude_matched_reasons" DROP DEFAULT,
ALTER COLUMN "claude_missing_skills" DROP DEFAULT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "first_name" TEXT,
ADD COLUMN     "last_name" TEXT;
