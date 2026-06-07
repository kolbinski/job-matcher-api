CREATE TABLE "user_offer_statuses" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_offer_id" TEXT NOT NULL,
  "status"        TEXT NOT NULL,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_offer_statuses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_offer_statuses_user_offer_id_fkey"
    FOREIGN KEY ("user_offer_id") REFERENCES "user_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
