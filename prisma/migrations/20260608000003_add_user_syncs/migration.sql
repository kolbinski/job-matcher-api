CREATE TABLE "user_syncs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "report" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_syncs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "user_syncs" ADD CONSTRAINT "user_syncs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
