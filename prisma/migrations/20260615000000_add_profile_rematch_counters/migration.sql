ALTER TABLE "users" ADD COLUMN "profile_relevant_change_counter" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "profile_relevant_change_counter_max" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "profile_relevant_change_pending" BOOLEAN NOT NULL DEFAULT false;
