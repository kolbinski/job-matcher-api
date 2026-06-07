-- CreateTable
CREATE TABLE "skills" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "skills_name_key" ON "skills"("name");

-- sync_skills: collect all unique skill names from offers and upsert into skills table
CREATE OR REPLACE FUNCTION sync_skills()
RETURNS void AS $$
BEGIN
  INSERT INTO skills (id, name)
  SELECT gen_random_uuid(), skill
  FROM (
    SELECT DISTINCT unnest(required_skills) AS skill FROM offers
    UNION
    SELECT DISTINCT unnest(nice_to_have_skills) AS skill FROM offers
  ) AS all_skills
  WHERE skill IS NOT NULL AND skill != ''
  ON CONFLICT (name) DO NOTHING;
END;
$$ LANGUAGE plpgsql;
