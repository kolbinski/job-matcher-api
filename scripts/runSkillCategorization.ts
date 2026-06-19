// One-time backfill: run the skill categorizer in a loop until every
// was_categorized=false skill has been processed.
//
//   npx ts-node scripts/runSkillCategorization.ts
//
// Load .env before importing anything from src/ — src/lib/env validates
// process.env at import time.
import 'dotenv/config'
import { prisma } from '../src/lib/prisma'
import { categorizeSkills } from '../src/jobs/categorizeSkills'

async function main(): Promise<void> {
  let batch = 0
  while (true) {
    const remaining = await prisma.skill.count({ where: { was_categorized: false } })
    if (remaining === 0) {
      console.log('[skill-categorizer] Done! All skills categorized.')
      break
    }

    batch++
    console.log(`[skill-categorizer] Batch ${batch}: processing up to 500 skills...`)

    await categorizeSkills()

    const after = await prisma.skill.count({ where: { was_categorized: false } })
    const categorized = remaining - after
    console.log(`[skill-categorizer] Batch ${batch} complete: categorized ${categorized} skills (${after} remaining)`)

    // Safety valve: if a batch makes no progress (e.g. repeated Claude API errors),
    // stop rather than loop forever.
    if (categorized <= 0) {
      console.error('[skill-categorizer] No progress this batch — stopping (check Claude API errors above).')
      break
    }
  }
}

main()
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
