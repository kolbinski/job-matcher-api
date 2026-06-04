-- Restore is_active column (removed in 20260604000000_remove_stripe_and_billing).
-- Existing rows default to true; soft-delete sets to false instead of deleting.
ALTER TABLE "offers" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;

-- Make offer_id nullable in user_offers so SET NULL works when an offer row is ever removed.
ALTER TABLE "user_offers" ALTER COLUMN "offer_id" DROP NOT NULL;

-- Replace CASCADE FK with SET NULL FK.
ALTER TABLE "user_offers" DROP CONSTRAINT "user_offers_offer_id_fkey";
ALTER TABLE "user_offers" ADD CONSTRAINT "user_offers_offer_id_fkey"
    FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
