-- Add UUID primary key to offers, keeping slug as unique index.
-- gen_random_uuid()::text backfills existing rows immediately (PostgreSQL 13+, no table rewrite).

ALTER TABLE "offers" ADD COLUMN "id" TEXT DEFAULT gen_random_uuid()::text NOT NULL;

ALTER TABLE "offers" DROP CONSTRAINT "offers_pkey";

ALTER TABLE "offers" ADD CONSTRAINT "offers_pkey" PRIMARY KEY ("id");

CREATE UNIQUE INDEX "offers_slug_key" ON "offers"("slug");
