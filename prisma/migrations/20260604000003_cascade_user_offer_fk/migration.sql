-- Change offer FK from RESTRICT to CASCADE so synced offer deletions
-- automatically clean up user_offers pipeline rows.
ALTER TABLE "user_offers" DROP CONSTRAINT "user_offers_offer_id_fkey";

ALTER TABLE "user_offers" ADD CONSTRAINT "user_offers_offer_id_fkey"
    FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
