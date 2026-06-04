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

// ── Raw JSON types (marek-wisniewski-profile.json format) ─────────────────────

interface RawProfile {
  basic_info: {
    name: string;
    email?: string;
    phone?: string;
    linkedin?: string;
    github?: string;
    location?: string;
    status?: string;
  };
  education?: Array<{
    institution: string;
    degree?: string;
    field?: string;
    from?: string;
    to?: string;
    gpa?: number;
    thesis?: string;
  }>;
  employment_history?: Array<{
    company: string;
    role: string;
    from: string;
    to?: string;
    company_type?: string;
    industry?: string;
    work_model?: string;
    projects?: Array<{
      name: string;
      technologies?: string[];
      team_size?: number;
      role?: string;
      achievements?: string[];
    }>;
  }>;
  personal_projects?: Array<{
    name: string;
    url?: string;
    technologies?: string[];
    status?: string;
    users?: number;
    github_stars?: number;
  }>;
  career_goals?: {
    target_role?: string;
    salary_min?: number;
    salary_max?: number;
    work_model?: string;
    max_office_days?: number;
    company_type?: string;
    industries?: string[];
    target_markets?: string[];
  };
  technologies: Array<{ name: string; since?: number }>;
  red_flags?: {
    rejected_company_types?: string[];
    rejected_technologies?: string[];
    rejected_work_models?: string[];
    other?: string[];
  };
}

// ── Response types ─────────────────────────────────────────────────────────────

interface OfferSalary {
  from: number;
  to: number;
  currency: string;
  type: string;
}

interface ScoreBreakdown {
  techScore: number;
  salaryScore: number;
  remoteScore: number;
  industryScore: number;
}

interface MatchedOffer {
  score: number;
  score_breakdown: ScoreBreakdown;
  title: string;
  company: string;
  salary: OfferSalary | null;
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

// ── Transform raw JSON → CandidateProfile schema ───────────────────────────────

const raw: RawProfile = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../data/marek-wisniewski-profile.json'),
    'utf-8',
  ),
);

const profile = {
  basic_info: {
    full_name: raw.basic_info.name,
    email: raw.basic_info.email,
    phone: raw.basic_info.phone,
    linkedin: raw.basic_info.linkedin,
    github: raw.basic_info.github,
    location: raw.basic_info.location
      ? { city: raw.basic_info.location, country_code: 'PL' }
      : undefined,
    remote_ok: raw.career_goals?.work_model === 'remote',
    job_search_status: raw.basic_info.status,
  },
  technologies: raw.technologies.map(t => ({ name: t.name, since: t.since })),
  education: raw.education?.map(e => ({
    institution: e.institution,
    degree: e.degree,
    field: e.field,
    date_from: e.from,
    date_to: e.to,
    gpa: e.gpa != null ? String(e.gpa) : undefined,
    thesis: e.thesis,
  })),
  work_experience: raw.employment_history?.map(job => ({
    company: job.company,
    title: job.role,
    date_from: job.from,
    date_to: job.to,
    company_type: job.company_type,
    industry: job.industry,
    work_model: job.work_model,
    projects: job.projects?.map(p => ({
      name: p.name,
      technologies: p.technologies,
      team_size: p.team_size,
      role: p.role,
      achievements: p.achievements,
    })),
  })),
  own_projects: raw.personal_projects?.map(p => ({
    name: p.name,
    demo_url: p.url,
    technologies: p.technologies,
    status: p.status,
    users: p.users,
    github_stars: p.github_stars,
  })),
  career_goals: {
    short_term: {
      target_role: raw.career_goals?.target_role
        ? [raw.career_goals.target_role]
        : undefined,
      company_type: raw.career_goals?.company_type,
      salary_target_pln_net_b2b:
        raw.career_goals?.salary_min != null
          ? {
              min: raw.career_goals.salary_min,
              max: raw.career_goals.salary_max ?? 0,
            }
          : undefined,
    },
  },
  preferences: {
    work_model: raw.career_goals?.work_model,
    max_office_days_per_week: raw.career_goals?.max_office_days,
    company_type: raw.career_goals?.company_type
      ? [raw.career_goals.company_type]
      : undefined,
    company_type_excluded: raw.red_flags?.rejected_company_types,
    industries: raw.career_goals?.industries,
    salary_pln_net_b2b:
      raw.career_goals?.salary_min != null
        ? {
            min: raw.career_goals.salary_min,
            max: raw.career_goals.salary_max ?? 0,
          }
        : undefined,
    markets: raw.career_goals?.target_markets,
  },
  red_flags: [
    ...(raw.red_flags?.rejected_company_types ?? []).map(v => ({
      category: 'company_type',
      description: v,
    })),
    ...(raw.red_flags?.rejected_technologies ?? []).map(v => ({
      category: 'technology',
      description: v,
    })),
    ...(raw.red_flags?.rejected_work_models ?? []).map(v => ({
      category: 'work_model',
      description: v,
    })),
    ...(raw.red_flags?.other ?? []).map(v => ({
      category: 'other',
      description: v,
    })),
  ],
};

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

  // ── Score breakdown for #1 ─────────────────────────────────────────────────
  if (matched.length > 0) {
    const top = matched[0];
    const b = top.score_breakdown;
    console.log(`\nScore breakdown — #1 ${top.title} @ ${top.company}:`);
    console.log('─'.repeat(62));
    console.log(`  techScore     ${b.techScore.toString().padStart(3)}/100  × 0.40 = ${(b.techScore * 0.40).toFixed(1)}`);
    console.log(`  salaryScore   ${b.salaryScore.toString().padStart(3)}/100  × 0.25 = ${(b.salaryScore * 0.25).toFixed(1)}`);
    console.log(`  remoteScore   ${b.remoteScore.toString().padStart(3)}/100  × 0.20 = ${(b.remoteScore * 0.20).toFixed(1)}`);
    console.log(`  industryScore ${b.industryScore.toString().padStart(3)}/100  × 0.15 = ${(b.industryScore * 0.15).toFixed(1)}`);
    console.log(`  ──────────────────────────────────`);
    console.log(`  total         ${top.score.toString().padStart(3)}/100`);
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
