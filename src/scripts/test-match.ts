import dotenv from 'dotenv';
import { prisma } from '../lib/prisma';

dotenv.config();

const BASE_URL = 'http://localhost:3000';

const userId = process.argv[2];
const debug = process.argv.includes('--debug');

if (!userId) {
  console.error('Usage: npx tsx src/scripts/test-match.ts <user_id> [--debug]');
  process.exit(1);
}

// ── Response types ─────────────────────────────────────────────────────────────

interface OfferSalary {
  from: number;
  to: number;
  currency: string;
  type: string;
  unit?: string;
}

interface MatchedOffer {
  score: number;
  rank: number | null;
  title: string;
  company: string;
  salary: OfferSalary | null;
  salaries?: OfferSalary[];
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
  salaries?: OfferSalary[];
  role_fit: string | null;
  missing_skills: string[];
  url: string | null;
}

interface SalaryPref {
  type: string;
  currency: string;
  min: number;
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

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatPLN(amount: number): string {
  return Math.round(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function formatSalaryRange(s: OfferSalary | null): string | null {
  if (!s || s.from == null || s.to == null) return null;
  return `${formatPLN(s.from)} – ${formatPLN(s.to)} ${s.currency} (${s.type})`;
}

function formatSalaryEmailLines(salaries: OfferSalary[], prefs: SalaryPref[]): string[] {
  if (salaries.length === 0) return ['salary not disclosed'];
  const matching = prefs.length > 0
    ? salaries.filter(s => prefs.some(p =>
        p.type.toLowerCase() === s.type.toLowerCase() &&
        p.currency.toUpperCase() === s.currency.toUpperCase()
      ))
    : [];
  const toShow = matching.length > 0 ? matching : salaries.slice(0, 1);
  const lines = toShow.map(s => formatSalaryEmailLine(s, resolveMin(s, prefs)));
  const realLines = lines.filter(l => l !== 'salary not disclosed');
  return realLines.length > 0 ? realLines : ['salary not disclosed'];
}

function resolveMin(salary: OfferSalary | null, prefs: SalaryPref[]): number | null {
  if (!salary || prefs.length === 0) return null;
  const match = prefs.find(
    p => p.type.toLowerCase() === salary.type.toLowerCase() &&
         p.currency.toUpperCase() === salary.currency.toUpperCase()
  );
  return match?.min ?? null;
}

// "24 000 – 27 000 PLN (b2b) — max 27 000 PLN, that's +5 000 PLN above your minimum"
function formatSalaryEmailLine(s: OfferSalary | null, min: number | null): string {
  if (!s || s.to == null) return 'salary not disclosed';
  const range = formatSalaryRange(s) ?? `${formatPLN(s.to)} ${s.currency}`;
  if (min === null) return `💰 ${range}`;
  const effectiveTo = s.unit?.toLowerCase() === 'day' ? s.to * 20 : s.to;
  const delta = effectiveTo - min;
  const absDelta = Math.abs(delta);
  const deltaStr = delta === 0
    ? 'exactly your minimum'
    : delta > 0
      ? `+${formatPLN(absDelta)} ${s.currency} above your minimum`
      : `-${formatPLN(absDelta)} ${s.currency} below your minimum`;
  return `💰 ${range} — max ${formatPLN(s.to)} ${s.currency}, that's ${deltaStr}`;
}

function titleAtCompany(title: string, company: string): string {
  if (/ @ .+$/.test(title.trimEnd())) return title.trimEnd();
  return `${title} @ ${company}`;
}

function dedupeByTitleCompany<T extends { title: string }>(
  arr: T[],
  companyKey: (t: T) => string,
  scoreKey?: (t: T) => number,
): T[] {
  const best = new Map<string, T>();
  for (const item of arr) {
    const key = `${item.title}|||${companyKey(item)}`;
    const existing = best.get(key);
    if (!existing || (scoreKey && scoreKey(item) > scoreKey(existing))) {
      best.set(key, item);
    }
  }
  return [...best.values()];
}

function todayDDMMYYYY(): string {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    console.error(`User not found: ${userId}`);
    process.exit(1);
  }

  let salaryPrefs: SalaryPref[] = [];
  let learningGoals: string[] = [];
  if (user.profile) {
    try {
      const raw = user.profile as {
        preferences?: { salary?: Array<{ type?: string; currency?: string; min?: number }>; learning_goals?: string[] }
      };
      salaryPrefs = (raw.preferences?.salary ?? [])
        .filter((p): p is SalaryPref => p.type != null && p.currency != null && p.min != null);
      learningGoals = (raw.preferences?.learning_goals ?? []).map(g => g.toLowerCase());
    } catch { /* profile unreadable — skip comparison labels */ }
  }

  if (debug) console.log(`Calling POST /v1/match for ${user.email} (${userId})...\n`);

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
  const stretch = data.stretch_offers ?? [];

  const requestedAiScoring = true;
  if (requestedAiScoring && (!meta.claude_evaluations_count || meta.claude_evaluations_count === 0)) {
    console.error('❌ Claude API failed — no evaluations returned. Check server logs.')
    process.exit(1)
  }

  const recommended = matched.filter(o => o.recommended === true);
  const considerApplying = matched.filter(o => o.recommended !== true && o.score >= 30);

  // ── Debug mode — full technical output ───────────────────────────────────────
  if (debug) {
    console.log(`Matched: ${meta.matched_count} | Unmatched: ${meta.unmatched_count} | Scanned: ${meta.total_offers_scanned} (${meta.response_ms}ms)\n`);
    console.log('Full meta:', JSON.stringify(data.meta))
    console.log('AI scoring:', data.meta?.ai_scoring, '| Claude evaluations:', data.meta?.claude_evaluations_count)

    if (!meta.ai_scoring) console.warn('⚠️  AI scoring disabled — results based on algorithm only.')

    function formatMatchedOffer(offer: MatchedOffer, i: number): void {
      const salaryRange = formatSalaryRange(offer.salary);
      const s = offer.salary;
      const targetMin = resolveMin(s, salaryPrefs);
      const salaryVsTarget = s && s.to != null && targetMin !== null
        ? s.to >= targetMin
          ? `✅ max ${formatPLN(s.to)} ${s.currency} meets target`
          : `❌ max ${formatPLN(s.to)} ${s.currency} below target of ${formatPLN(targetMin)}`
        : null;

      console.log('\n' + '─'.repeat(62));
      console.log(`${i + 1}. [${offer.score}/100] ${offer.title} @ ${offer.company}`);
      console.log(`   salary:           ${salaryRange ?? 'not disclosed'}`);
      if (salaryVsTarget)           console.log(`   salary_vs_target: ${salaryVsTarget}`);
      if (offer.role_fit)           console.log(`   role_fit:         ${offer.role_fit}`);
      if (offer.matched_reasons.length > 0) offer.matched_reasons.forEach(r => console.log(`   ✓ ${r}`));
      if (offer.missing_skills.length > 0)  console.log(`   missing:          ${offer.missing_skills.join(', ')}`);
      if (offer.url)                console.log(`   url:              ${offer.url}`);
    }

    console.log(`\n✅ Recommended offers (${recommended.length} total):`);
    if (recommended.length === 0) console.log('  (none)');
    else recommended.forEach((o, i) => formatMatchedOffer(o, i));

    console.log(`\n⚠️  Consider applying (${considerApplying.length} total):`);
    if (considerApplying.length === 0) console.log('  (none)');
    else considerApplying.forEach((o, i) => formatMatchedOffer(o, i));

    console.log(`\n❌ Pre-filter rejected (${meta.unmatched_count} total):`);
    console.log('─'.repeat(62));
    unmatched.slice(0, 30).forEach(offer => {
      const reqSkills = offer.required_skills ?? [];
      const skills = reqSkills.length > 0
        ? reqSkills.slice(0, 6).join(', ') + (reqSkills.length > 6 ? '…' : '')
        : 'none listed';
      const reason = offer.rejection_reasons[0] ?? 'unknown';
      const salary = formatSalaryRange(offer.salary);
      console.log(`\n- ${offer.title} @ ${offer.company}`);
      console.log(`  reason: ${reason}`);
      console.log(`  skills: ${skills}`);
      if (salary)      console.log(`  salary: ${salary}`);
      if (offer.url)   console.log(`  url:    ${offer.url}`);
    });
    if (meta.unmatched_count > 30) console.log(`\n  … and ${meta.unmatched_count - 30} more`);

    console.log('\n' + '─'.repeat(62));
    console.log(`Stretch offers — learn these skills to unlock better roles (${stretch.length} total):`);
    console.log('─'.repeat(62));
    if (stretch.length === 0) {
      console.log('  (none — no ai_rejected offers overlap with your learning_goals)');
    } else {
      stretch.forEach((offer, i) => {
        const s = offer.salary;
        const stretchMin = resolveMin(s, salaryPrefs);
        const salaryLabel = s && s.to != null && stretchMin !== null
          ? s.to >= stretchMin
            ? ` — above client's minimum of ${formatPLN(stretchMin)} PLN`
            : ` — below client's minimum of ${formatPLN(stretchMin)} PLN`
          : '';
        const salary = formatSalaryRange(s)
          ? `${formatSalaryRange(s)}${salaryLabel}`
          : 'salary not disclosed';
        const learningGoalHits = offer.missing_skills.filter(sk => learningGoals.includes(sk.toLowerCase()));
        console.log(`\n${i + 1}. ${offer.title} @ ${offer.company_name}`);
        console.log(`   salary:                   ${salary}`);
        if (offer.role_fit) console.log(`   role_fit:                 ${offer.role_fit}`);
        console.log(`   missing (your learning goals): ${learningGoalHits.join(', ') || offer.missing_skills.join(', ')}`);
        if (offer.url) console.log(`   url:                      ${offer.url}`);
      });
    }

    return;
  }

  // ── Email report mode ─────────────────────────────────────────────────────────
  const firstName = (user.profile as { basic_info?: { first_name?: string } } | null)?.basic_info?.first_name ?? user.email.split('@')[0];
  const newOffersCount = recommended.length + stretch.length; // counts before dedup (dedup happens per section below)

  console.log(`Hi ${firstName}! Here are your job matches for ${todayDDMMYYYY()}`);
  console.log(`Found ${newOffersCount} new offers for you (from ${meta.total_offers_scanned} newly processed offers today)`);

  // Section 1 — Apply now
  const dedupedRecommended = dedupeByTitleCompany(recommended, o => o.company, o => o.score);
  console.log(`\n\n\n🎯 Apply now (${dedupedRecommended.length} offers)\n`);
  if (dedupedRecommended.length === 0) {
    console.log('  No strongly recommended offers this scan.');
  } else {
    dedupedRecommended.forEach(offer => {
      const salaryLines = formatSalaryEmailLines(offer.salaries ?? (offer.salary ? [offer.salary] : []), salaryPrefs);
      console.log(`${offer.score}/100  ${titleAtCompany(offer.title, offer.company)}`);
      salaryLines.forEach(line => console.log(`   ${line}`));
      if (offer.role_fit) console.log(`   ${offer.role_fit}`);
      if (offer.url) console.log(`   🔗 ${offer.url}`);
      console.log('');
    });
  }

  // Section 2 — Level up & earn more
  const dedupedStretch = dedupeByTitleCompany(stretch, o => o.company_name);
  console.log(`\n\n\n📚 Level up & earn more (${dedupedStretch.length} offers)\n`);
  if (dedupedStretch.length === 0) {
    console.log('  No stretch offers this scan.');
  } else {
    dedupedStretch.forEach(offer => {
      const salaryLines = formatSalaryEmailLines(offer.salaries ?? (offer.salary ? [offer.salary] : []), salaryPrefs);
      const learningGoalHits = offer.missing_skills.filter(sk => learningGoals.includes(sk.toLowerCase()));
      console.log(titleAtCompany(offer.title, offer.company_name));
      salaryLines.forEach(line => console.log(`   ${line}`));
      if (offer.role_fit) console.log(`   ${offer.role_fit}`);
      if (learningGoalHits.length > 0) console.log(`   Skills to learn: ${learningGoalHits.join(', ')}`);
      if (offer.url) console.log(`   🔗 ${offer.url}`);
      console.log('');
    });
  }

  // Section 3 — Worth considering
  const stretchUrls = new Set(stretch.map(o => o.url).filter((u): u is string => u != null));
  const dedupedConsider = dedupeByTitleCompany(considerApplying, o => o.company, o => o.score);
  const visibleConsider = dedupedConsider.filter(o => {
    if (o.url != null && stretchUrls.has(o.url)) return false;
    const salaries = o.salaries ?? (o.salary ? [o.salary] : []);
    if (salaries.length === 0 || salaryPrefs.length === 0) return true;
    const matching = salaries.filter(s => salaryPrefs.some(p =>
      p.type.toLowerCase() === s.type.toLowerCase() &&
      p.currency.toUpperCase() === s.currency.toUpperCase()
    ));
    if (matching.length === 0) return true; // no matching type → undisclosed for our prefs → show
    return matching.some(s => { const min = resolveMin(s, salaryPrefs); return min === null || s.to >= min; });
  });

  console.log(`\n\n\n💡 Worth considering (${visibleConsider.length} offers)\n`);
  if (visibleConsider.length === 0) {
    console.log('  No additional offers above score threshold.');
  } else {
    visibleConsider.forEach(offer => {
      const salaryLines = formatSalaryEmailLines(offer.salaries ?? (offer.salary ? [offer.salary] : []), salaryPrefs);
      console.log(titleAtCompany(offer.title, offer.company));
      salaryLines.forEach(line => console.log(`   ${line}`));
      if (offer.url) console.log(`   🔗 ${offer.url}`);
      console.log('');
    });
  }

  console.log('\n\n\nNext scan: tomorrow morning');
}

main().finally(() => prisma.$disconnect());
