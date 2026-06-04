import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = 'https://job-matcher-api-production.up.railway.app';

const API_KEY = process.env.JOBMATCHER_API_KEY;
if (!API_KEY) {
  console.error('Missing JOBMATCHER_API_KEY in .env');
  process.exit(1);
}

// marek-wisniewski-profile.json is already in CandidateProfile schema format —
// no transformation needed, send it directly.

// ── Response types ─────────────────────────────────────────────────────────────

interface OfferSalary {
  from: number;
  to: number;
  currency: string;
  type: string;
}

interface MatchedOffer {
  score: number;
  title: string;
  company: string;
  salary: OfferSalary | null;
  matched_reasons: string[];
  missing_skills: string[];
  role_fit: string | null;
  recommended: boolean | null;
}

interface UnmatchedOffer {
  title: string;
  company: string;
  rejection_reasons: string[];
  required_skills: string[];
}

interface MatchResponse {
  meta: {
    matched_count: number;
    unmatched_count: number;
    total_offers_scanned: number;
    response_ms: number;
  };
  matched: MatchedOffer[];
  unmatched: UnmatchedOffer[];
}

const profile = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../data/marek-wisniewski-profile.json'),
    'utf-8',
  ),
);

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Calling POST /v1/match for Marek Wiśniewski...\n');

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/v1/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ profile, options: { include_unmatched: true, ai_scoring: false } }),
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

  // ── Top 5 matched ──────────────────────────────────────────────────────────
  console.log('Top 5 by score:');
  console.log('─'.repeat(62));

  matched.slice(0, 5).forEach((offer, i) => {
    const s = offer.salary;
    const salary =
      s && s.from != null && s.to != null
        ? `${s.from.toLocaleString('pl-PL')} – ${s.to.toLocaleString('pl-PL')} ${s.currency} (${s.type})`
        : 'salary not disclosed';
    console.log(`${i + 1}. [${offer.score}/100] ${offer.title} @ ${offer.company}`);
    console.log(`   ${salary}`);
  });

  // ── Claude evaluation for #1 ──────────────────────────────────────────────
  if (matched.length > 0) {
    const top = matched[0];
    console.log(`\n#1 ${top.title} @ ${top.company} — score: ${top.score}/100`);
    console.log('─'.repeat(62));
    if (top.role_fit) {
      console.log(`  role_fit:       ${top.role_fit}`);
    }
    if (top.matched_reasons.length > 0) {
      console.log(`  matched_reasons: ${top.matched_reasons.join(' · ')}`);
    }
    if (top.missing_skills.length > 0) {
      console.log(`  missing_skills:  ${top.missing_skills.join(', ')}`);
    }
    if (top.recommended !== null) {
      console.log(`  recommended:    ${top.recommended}`);
    }
  }

  // ── Unmatched analysis ────────────────────────────────────────────────────
  console.log(`\nUnmatched analysis (${meta.unmatched_count} total):`);
  console.log('─'.repeat(62));

  // Group offers by each individual rejection reason
  const byReason = new Map<string, UnmatchedOffer[]>();
  for (const offer of unmatched) {
    for (const reason of offer.rejection_reasons) {
      const group = byReason.get(reason) ?? [];
      group.push(offer);
      byReason.set(reason, group);
    }
  }

  // Sort by count descending, take top 10
  const ranked = [...byReason.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10);

  ranked.forEach(([reason, offers], i) => {
    console.log(`\n${i + 1}. "${reason}" — ${offers.length} offer${offers.length === 1 ? '' : 's'}`);
    offers.slice(0, 3).forEach(offer => {
      const reqSkills = offer.required_skills ?? [];
      const skills = reqSkills.length > 0
        ? reqSkills.slice(0, 6).join(', ') + (reqSkills.length > 6 ? '…' : '')
        : 'none listed';
      console.log(`   • ${offer.title} @ ${offer.company}`);
      console.log(`     skills: ${skills}`);
    });
  });
}

main();
