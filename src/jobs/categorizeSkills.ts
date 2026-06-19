import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { getClaudeModel } from '../lib/claudeModels';
import { calculateCost } from '../lib/aiCost';

const BATCH_SIZE = 500;

// Classify up to BATCH_SIZE uncategorized skills in a single Claude call, then map
// each result back to a skill_category by name (case-insensitive). Skills the model
// can't be matched to a known category are still marked was_categorized=true so they
// aren't retried forever (their category_id is left untouched).
export async function categorizeSkills(): Promise<void> {
  const skills = await prisma.skill.findMany({
    where: { was_categorized: false },
    take: BATCH_SIZE,
    select: { id: true, name: true },
  });
  if (skills.length === 0) return;

  const categories = await prisma.skillCategory.findMany({
    select: { id: true, name: true },
  });
  const categoryNames = categories.map(c => c.name);
  const skillNames = skills.map(s => s.name);

  const model = await getClaudeModel('skill_categorization');

  const prompt = `Classify each skill into exactly one category. Categories: ${categoryNames.join(', ')}.
Skills to classify: ${skillNames.join(', ')}.
Reply ONLY with valid JSON object: { "skill name": "category name", ... }`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      // Large enough to fit a JSON map for a full 500-skill batch without truncating.
      model,
      max_tokens: 16000,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(55_000),
  });

  if (!response.ok) {
    const errBody = await response.text();
    console.error(`[skill-categorizer] Claude API error ${response.status}: ${errBody}`);
    return;
  }

  const data = (await response.json()) as {
    content: Array<{ text: string }>;
    usage?: { input_tokens: number; output_tokens: number };
  };

  // Record token usage. This is a system job — no user_id/email.
  const usage = data.usage;
  if (usage) {
    calculateCost(model, usage.input_tokens, usage.output_tokens)
      .then(cost =>
        prisma.aiUsage.create({
          data: {
            type: 'skill_categorization',
            model,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cost,
          },
        }),
      )
      .catch(err => console.error('[ai_usage] insert failed:', err));
  }

  const raw = data.content[0].text.trim();
  const clean = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let mapping: Record<string, string>;
  try {
    mapping = JSON.parse(clean) as Record<string, string>;
  } catch {
    console.error('[skill-categorizer] Claude returned invalid JSON — skipping batch');
    return;
  }

  // Case-insensitive lookups: category by name, and the model's answer by skill name.
  const categoryByName = new Map(categories.map(c => [c.name.toLowerCase(), c]));
  const answerBySkill = new Map(
    Object.entries(mapping).map(([skill, category]) => [skill.toLowerCase(), category]),
  );

  let categorized = 0;
  for (const skill of skills) {
    const answer = answerBySkill.get(skill.name.toLowerCase());
    const category = answer ? categoryByName.get(answer.toLowerCase()) : undefined;
    if (category) {
      await prisma.skill.update({
        where: { id: skill.id },
        data: { category_id: category.id, was_categorized: true },
      });
      categorized++;
    } else {
      // No category match — mark as categorized anyway to avoid an infinite loop;
      // leave the existing category_id as-is.
      await prisma.skill.update({
        where: { id: skill.id },
        data: { was_categorized: true },
      });
    }
  }

  console.log(`[skill-categorizer] categorized ${categorized} skills`);
}
