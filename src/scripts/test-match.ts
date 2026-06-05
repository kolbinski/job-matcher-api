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
  url: string | null;
}

interface UnmatchedOffer {
  title: string;
  company: string;
  salary: OfferSalary | null;
  rejection_reasons: string[];
  required_skills: string[];
  url: string | null;
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
  let learningGoals: string[] = [];
  if (user.profile_path) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.resolve(user.profile_path), 'utf-8')) as {
        preferences?: { salary?: Array<{ min?: number }>; learning_goals?: string[] }
      };
      salaryMin = raw.preferences?.salary?.[0]?.min ?? null;
      learningGoals = (raw.preferences?.learning_goals ?? []).map(g => g.toLowerCase());
    } catch { /* profile unreadable — skip comparison labels */ }
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

  const requestedAiScoring = true // we always send ai_scoring: true
  if (requestedAiScoring && (!meta.claude_evaluations_count || meta.claude_evaluations_count === 0)) {
    console.error('❌ Claude API failed — no evaluations returned. Check server logs.')
    process.exit(1)
  }

  if (!meta.ai_scoring) {
    console.warn('⚠️  AI scoring disabled — results based on algorithm only.')
  }

  // ── Recommended offers ────────────────────────────────────────────────────
  const recommended = matched.filter(o => o.recommended === true);
  const considerApplying = matched.filter(o => o.recommended !== true && o.score >= 30);

  function formatMatchedOffer(offer: MatchedOffer, i: number): void {
    const s = offer.salary;
    const salaryRange = s && s.from != null && s.to != null
      ? `${s.from.toLocaleString('pl-PL')} – ${s.to.toLocaleString('pl-PL')} ${s.currency} (${s.type})`
      : null;
    const salaryVsTarget = s && s.to != null && salaryMin !== null
      ? s.to >= salaryMin
        ? `✅ max ${s.to.toLocaleString('pl-PL')} ${s.currency} meets target`
        : `❌ max ${s.to.toLocaleString('pl-PL')} ${s.currency} below target of ${salaryMin.toLocaleString('pl-PL')}`
      : null;

    console.log('\n' + '─'.repeat(62));
    console.log(`${i + 1}. [${offer.score}/100] ${offer.title} @ ${offer.company}`);
    if (salaryRange) console.log(`   salary:           ${salaryRange}`);
    else             console.log(`   salary:           not disclosed`);
    if (salaryVsTarget)           console.log(`   salary_vs_target: ${salaryVsTarget}`);
    if (offer.role_fit)           console.log(`   role_fit:         ${offer.role_fit}`);
    if (offer.matched_reasons.length > 0) {
      offer.matched_reasons.forEach(r => console.log(`   ✓ ${r}`));
    }
    if (offer.missing_skills.length > 0) {
      console.log(`   missing:          ${offer.missing_skills.join(', ')}`);
    }
    if (offer.url)                console.log(`   url:              ${offer.url}`);
  }

  console.log(`\n✅ Recommended offers (${recommended.length} total):`);
  if (recommended.length === 0) {
    console.log('  (none)');
  } else {
    recommended.forEach((offer, i) => formatMatchedOffer(offer, i));
  }

  console.log(`\n⚠️  Consider applying (${considerApplying.length} total):`);
  if (considerApplying.length === 0) {
    console.log('  (none)');
  } else {
    considerApplying.forEach((offer, i) => formatMatchedOffer(offer, i));
  }

  // ── Pre-filter rejected ───────────────────────────────────────────────────
  console.log(`\n❌ Pre-filter rejected (${meta.unmatched_count} total):`);
  console.log('─'.repeat(62));

  unmatched.slice(0, 30).forEach(offer => {
    const reqSkills = offer.required_skills ?? [];
    const skills = reqSkills.length > 0
      ? reqSkills.slice(0, 6).join(', ') + (reqSkills.length > 6 ? '…' : '')
      : 'none listed';
    const reason = offer.rejection_reasons[0] ?? 'unknown';
    const s = offer.salary;
    const salary = s && s.from != null && s.to != null
      ? `${s.from.toLocaleString('pl-PL')} – ${s.to.toLocaleString('pl-PL')} ${s.currency} (${s.type})`
      : null;
    console.log(`\n- ${offer.title} @ ${offer.company}`);
    console.log(`  reason: ${reason}`);
    console.log(`  skills: ${skills}`);
    if (salary) console.log(`  salary: ${salary}`);
    if (offer.url) console.log(`  url:    ${offer.url}`);
  });
  if (meta.unmatched_count > 30) {
    console.log(`\n  … and ${meta.unmatched_count - 30} more`);
  }


  // ── Stretch offers ────────────────────────────────────────────────────────
  const stretch = data.stretch_offers ?? [];
  console.log('\n' + '─'.repeat(62));
  console.log(`Stretch offers — learn these skills to unlock better roles (${stretch.length} total):`);
  console.log('─'.repeat(62));

  if (stretch.length === 0) {
    console.log('  (none — no ai_rejected offers overlap with your learning_goals)');
  } else {
    stretch.forEach((offer, i) => {
      const s = offer.salary;
      let salaryLabel = '';
      if (s && salaryMin !== null) {
        salaryLabel = s.to >= salaryMin
          ? ` — above client's minimum of ${salaryMin.toLocaleString('pl-PL')} PLN`
          : ` — below client's minimum of ${salaryMin.toLocaleString('pl-PL')} PLN`;
      }
      const salary = s && s.from != null && s.to != null
        ? `${s.from.toLocaleString('pl-PL')} – ${s.to.toLocaleString('pl-PL')} ${s.currency} (${s.type})${salaryLabel}`
        : 'salary not disclosed';

      const learningGoalHits = offer.missing_skills.filter(skill =>
        learningGoals.includes(skill.toLowerCase())
      );

      console.log(`\n${i + 1}. ${offer.title} @ ${offer.company_name}`);
      console.log(`   salary:                   ${salary}`);
      if (offer.role_fit) {
        console.log(`   role_fit:                 ${offer.role_fit}`);
      }
      console.log(`   missing (your learning goals): ${learningGoalHits.join(', ') || offer.missing_skills.join(', ')}`);
      if (offer.url) {
        console.log(`   url:                      ${offer.url}`);
      }
    });
  }
}

main().finally(() => prisma.$disconnect());
