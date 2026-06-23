ALTER TABLE "users" DROP COLUMN "free_plan_snapshot";
ALTER TABLE "users" ADD COLUMN "status_change_counter" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "status_change_counter_max" INTEGER;
ALTER TABLE "plans" ADD COLUMN "max_status_change" INTEGER;
UPDATE "plans" SET "max_status_change" = 30 WHERE "name" = 'free';
