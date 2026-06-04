-- Revert the offer_id nullable + SET NULL FK from migration 20260604000004.
-- Keeping CASCADE and offer_id NOT NULL as originally designed.

ALTER TABLE "user_offers" DROP CONSTRAINT "user_offers_offer_id_fkey";

ALTER TABLE "user_offers" ADD CONSTRAINT "user_offers_offer_id_fkey"
    FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_offers" ALTER COLUMN "offer_id" SET NOT NULL;
