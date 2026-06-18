-- CreateTable
CREATE TABLE "user_deleted" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "delete_reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "feedback" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_deleted_pkey" PRIMARY KEY ("id")
);
