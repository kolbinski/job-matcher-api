import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { prisma } from '../lib/prisma';

dotenv.config();

const BASE_URL = 'http://localhost:3000';

const userId = process.argv[2];
if (!userId) {
  console.error('Usage: npx tsx src/scripts/test-match.ts <user_id>');
  process.exit(1);
}

// ── Response types ─────────────────────────────────────────────────────────────

interface OfferSalary {
  from: number;
  to: number;
  currency: string;
  type: string;
}

interface MatchedOffer {
  score: number;
  rank: number | null;
  title: string;
  company: string;
  salary: OfferSalary | null;
  matched_reasons: string[];
  missing_skills: string[];
  salary_comparison: string | null;
  role_fit: string | null;
  recommended: boolean | null;
}

interface UnmatchedOffer {
  title: string;
  company: string;
  rejection_reasons: string[];
  required_skills: string[];
}

interface StretchOffer {
  title: string;
  company_name: string;
  salary: OfferSalary | null;
  role_fit: string | null;
  missing_skills: string[];
  url: string | null;
}

interface MatchResponse {
  meta: {
    matched_count: number;
    unmatched_count: number;
    total_offers_scanned: number;
    response_ms: number;
    ai_scoring: boolean;
    claude_evaluations_count: number;
  };
  matched: MatchedOffer[];
  unmatched: UnmatchedOffer[];
  stretch_offers: StretchOffer[];
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    console.error(`User not found: ${userId}`);
    process.exit(1);
  }

  // Read salary minimum from profile for display comparisons
  let salaryMin: number | null = null;
  if (user.profile_path) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.resolve(user.profile_path), 'utf-8')) as {
        preferences?: { salary?: Array<{ min?: number }> }
      };
      salaryMin = raw.preferences?.salary?.[0]?.min ?? null;
    } catch { /* profile unreadable — skip comparison label */ }
  }

  console.log(`Calling POST /v1/match for ${user.email} (${userId})...\n`);

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/v1/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': user.jobmatcher_api_key },
      body: JSON.stringify({ options: { include_unmatched: true, ai_scoring: true } }),
    });
  } catch {
    console.error('Connection refused — is the server running? (npm run dev)');
    process.exit(1);
  }

  if (!res.ok) {
    const body = await res.text();
    console.error(`HTTP ${res.status}: ${body}`);
    process.exit(1);
  }

  const data = (await res.json()) as MatchResponse;
  const { meta, matched, unmatched } = data;

  console.log(
    `Matched: ${meta.matched_count} | Unmatched: ${meta.unmatched_count} | Scanned: ${meta.total_offers_scanned} (${meta.response_ms}ms)\n`,
  );

  console.log('Full meta:', JSON.stringify(data.meta))
  console.log('AI scoring:', data.meta?.ai_scoring, '| Claude evaluations:', data.meta?.claude_evaluations_count)

  if (!meta.ai_scoring) {
    console.warn('⚠️  AI scoring disabled — results based on algorithm only.')
  } else if (meta.claude_evaluations_count === 0) {
    console.error('❌ Claude API failed — no evaluations returned. Check server logs.')
    process.exit(1)
  }

  // ── Top 5 matched with full Claude evaluation ─────────────────────────────
  console.log('\nTop 5 by score:');

  matched.slice(0, 5).forEach((offer, i) => {
    const s = offer.salary;
    let salaryLabel = '';
    if (s && salaryMin !== null) {
      salaryLabel = s.to >= salaryMin
        ? ` — above client's minimum of ${salaryMin.toLocaleString('pl-PL')} PLN`
        : ` — below client's minimum of ${salaryMin.toLocaleString('pl-PL')} PLN`;
    }
    const salary =
      s && s.from != null && s.to != null
        ? `${s.from.toLocaleString('pl-PL')} – ${s.to.toLocaleString('pl-PL')} ${s.currency} (${s.type})${salaryLabel}`
        : 'salary not disclosed';

    console.log('\n' + '─'.repeat(62));
    console.log(`${i + 1}. [${offer.score}/100] ${offer.title} @ ${offer.company}`);
    console.log(`   salary:          ${salary}`);

    if (offer.role_fit) {
      console.log(`   role_fit:        ${offer.role_fit}`);
    }
    if (offer.recommended !== null) {
      console.log(`   recommended:     ${offer.recommended}`);
    }
    if (offer.salary_comparison) {
      console.log(`   salary_vs_target: ${offer.salary_comparison}`);
    }
    if (offer.matched_reasons.length > 0) {
      offer.matched_reasons.forEach(r => console.log(`   ✓ ${r}`));
    }
    if (offer.missing_skills.length > 0) {
      console.log(`   missing:         ${offer.missing_skills.join(', ')}`);
    }
  });

  // ── Unmatched analysis ────────────────────────────────────────────────────
  console.log(`\nUnmatched analysis (${meta.unmatched_count} total):`);
  console.log('─'.repeat(62));

  unmatched.slice(0, 30).forEach(offer => {
    const reqSkills = offer.required_skills ?? [];
    const skills = reqSkills.length > 0
      ? reqSkills.slice(0, 6).join(', ') + (reqSkills.length > 6 ? '…' : '')
      : 'none listed';
    const reason = offer.rejection_reasons[0] ?? 'unknown';
    console.log(`\n- ${offer.title} @ ${offer.company}`);
    console.log(`  reason: ${reason}`);
    console.log(`  skills: ${skills}`);
  });
}

main().finally(() => prisma.$disconnect());
