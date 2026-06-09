ALTER TABLE "users" RENAME COLUMN "send_notifications_hour" TO "send_job_applied_notifications_hour";
ALTER TABLE "users" ADD COLUMN "send_sync_report_notifications_hour" INTEGER NOT NULL DEFAULT 9;
