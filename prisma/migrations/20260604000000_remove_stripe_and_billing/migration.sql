-- Remove Stripe/billing columns from users
ALTER TABLE "users" DROP COLUMN "credits";
ALTER TABLE "users" DROP COLUMN "auto_refill";
ALTER TABLE "users" DROP COLUMN "auto_refill_amount";
ALTER TABLE "users" DROP COLUMN "auto_refill_threshold";
ALTER TABLE "users" DROP COLUMN "stripe_customer_id";
ALTER TABLE "users" DROP COLUMN "stripe_payment_method";

-- Remove billing columns from api_calls
ALTER TABLE "api_calls" DROP COLUMN "cost";
ALTER TABLE "api_calls" DROP COLUMN "profile_hash";
