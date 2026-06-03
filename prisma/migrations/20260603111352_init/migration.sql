-- CreateTable
CREATE TABLE "settings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "jobmatcher_api_key" TEXT NOT NULL,
    "credits" DECIMAL(10,4) NOT NULL,
    "auto_refill" BOOLEAN NOT NULL DEFAULT false,
    "auto_refill_amount" DECIMAL(10,2),
    "auto_refill_threshold" DECIMAL(10,2),
    "stripe_customer_id" TEXT,
    "stripe_payment_method" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers" (
    "slug" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "company_name" TEXT NOT NULL,
    "company_logo_url" TEXT,
    "experience_level" TEXT,
    "workplace_type" TEXT,
    "working_time" TEXT,
    "remote_interview" BOOLEAN,
    "required_skills" TEXT[],
    "nice_to_have_skills" TEXT[],
    "employment_types" JSONB NOT NULL,
    "multilocation" JSONB,
    "city" TEXT,
    "street" TEXT,
    "latitude" DECIMAL(11,7),
    "longitude" DECIMAL(11,7),
    "category_id" INTEGER,
    "open_to_hire_ukrainians" BOOLEAN,
    "languages" TEXT[],
    "url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "published_at" TIMESTAMP(3),
    "fetched_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("slug")
);

-- CreateTable
CREATE TABLE "api_calls" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "called_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cost" DECIMAL(10,4) NOT NULL,
    "profile_hash" TEXT,
    "offers_matched" INTEGER,
    "offers_total" INTEGER,
    "response_ms" INTEGER,
    "status" TEXT NOT NULL,
    "error_message" TEXT,

    CONSTRAINT "api_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "settings_key_key" ON "settings"("key");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_jobmatcher_api_key_key" ON "users"("jobmatcher_api_key");

-- AddForeignKey
ALTER TABLE "api_calls" ADD CONSTRAINT "api_calls_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
