ALTER TABLE "api_calls"
ADD COLUMN "input_tokens"  INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "output_tokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "call_type"     TEXT,
ADD COLUMN "model"         TEXT;
