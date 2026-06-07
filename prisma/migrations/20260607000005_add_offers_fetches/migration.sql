CREATE TABLE "offer_fetches" (
  "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
  "source"            TEXT NOT NULL,
  "new_upserts_count" INTEGER NOT NULL,
  "fetched_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "offer_fetches_pkey" PRIMARY KEY ("id")
);
