-- AlterTable
ALTER TABLE "user_offers" DROP COLUMN "salary_delta",
DROP COLUMN "salary_max",
DROP COLUMN "salary_min",
DROP COLUMN "salary_type",
ADD COLUMN     "salary_contract_delta" DOUBLE PRECISION,
ADD COLUMN     "salary_permanent_delta" DOUBLE PRECISION;
