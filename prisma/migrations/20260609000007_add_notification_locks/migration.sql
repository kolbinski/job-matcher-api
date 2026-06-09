-- CreateTable
CREATE TABLE "notification_locks" (
    "id" TEXT NOT NULL,
    "lock_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_locks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_locks_lock_key_key" ON "notification_locks"("lock_key");
