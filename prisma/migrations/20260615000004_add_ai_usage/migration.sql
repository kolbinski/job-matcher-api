CREATE TABLE "ai_usage" (
  "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "user_id"       TEXT,
  "email"         TEXT,
  "type"          TEXT NOT NULL,
  "model"         TEXT NOT NULL,
  "input_tokens"  INTEGER NOT NULL,
  "output_tokens" INTEGER NOT NULL,
  "cost"          DOUBLE PRECISION NOT NULL,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);
