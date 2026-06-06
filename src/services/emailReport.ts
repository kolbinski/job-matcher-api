import fs from 'fs'
import path from 'path'
import type { MatchResponse, OfferSalary } from '../types/match'

interface SalaryPref {
  type: string
  currency: string
  min: number
}

export function buildEmailReport(
  result: MatchResponse,
  user: { first_name: string | null; profile_path: string | null },
): string {
  const { meta, matched, stretch_offers: stretch } = result

  let salaryPrefs: SalaryPref[] = []
  let learningGoals: string[] = []

  if (user.profile_path) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.resolve(user.profile_path), 'utf-8')) as {
        preferences?: {
          salary?: Array<{ type?: string; currency?: string; min?: number }>
          learning_goals?: string[]
        }
      }
      salaryPrefs = (raw.preferences?.salary ?? [])
        .filter((p): p is SalaryPref => p.type != null && p.currency != null && p.min != null)
      learningGoals = (raw.preferences?.learning_goals ?? []).map(g => g.toLowerCase())
    } catch { /* profile unreadable — skip salary labels */ }
  }

  const recommended = matched.filter(o => o.recommended === true)
  const considerApplying = matched.filter(o => o.recommended !== true && o.score >= 30)

  const firstName = user.first_name ?? 'there'
  const newOffersCount = recommended.length + stretch.length

  const lines: string[] = []

  lines.push(`Hi ${firstName}! Here are your job matches for ${todayDDMMYYYY()}`)
  lines.push(`Found ${newOffersCount} new offers for you (from ${meta.total_offers_scanned} newly processed offers today)`)

  // Section 1 — Apply now
  const dedupedRecommended = dedupeByTitleCompany(recommended, o => o.company, o => o.score)
  lines.push(`\n\n\n🎯 Apply now (${dedupedRecommended.length} offers)\n`)
  if (dedupedRecommended.length === 0) {
    lines.push('  No strongly recommended offers this scan.')
  } else {
    for (const offer of dedupedRecommended) {
      const salaryLines = formatSalaryEmailLines(offer.salaries ?? (offer.salary ? [offer.salary] : []), salaryPrefs)
      lines.push(`${offer.score}/100  ${titleAtCompany(offer.title, offer.company)}`)
      for (const line of salaryLines) lines.push(`   ${line}`)
      if (offer.role_fit) lines.push(`   ${offer.role_fit}`)
      if (offer.url) lines.push(`   🔗 ${offer.url}`)
      lines.push('')
    }
  }

  // Section 2 — Level up & earn more
  const dedupedStretch = dedupeByTitleCompany(stretch, o => o.company_name)
  lines.push(`\n\n\n📚 Level up & earn more (${dedupedStretch.length} offers)\n`)
  if (dedupedStretch.length === 0) {
    lines.push('  No stretch offers this scan.')
  } else {
    for (const offer of dedupedStretch) {
      const salaryLines = formatSalaryEmailLines(offer.salaries ?? (offer.salary ? [offer.salary] : []), salaryPrefs)
      const learningGoalHits = offer.missing_skills.filter(sk => learningGoals.includes(sk.toLowerCase()))
      lines.push(titleAtCompany(offer.title, offer.company_name))
      for (const line of salaryLines) lines.push(`   ${line}`)
      if (offer.role_fit) lines.push(`   ${offer.role_fit}`)
      if (learningGoalHits.length > 0) lines.push(`   Skills to learn: ${learningGoalHits.join(', ')}`)
      if (offer.url) lines.push(`   🔗 ${offer.url}`)
      lines.push('')
    }
  }

  // Section 3 — Worth considering
  const stretchUrls = new Set(stretch.map(o => o.url).filter((u): u is string => u != null))
  const dedupedConsider = dedupeByTitleCompany(considerApplying, o => o.company, o => o.score)
  const visibleConsider = dedupedConsider.filter(o => {
    if (o.url != null && stretchUrls.has(o.url)) return false
    const salaries = o.salaries ?? (o.salary ? [o.salary] : [])
    if (salaries.length === 0 || salaryPrefs.length === 0) return true
    const matching = salaries.filter(s => salaryPrefs.some(p =>
      p.type.toLowerCase() === s.type.toLowerCase() &&
      p.currency.toUpperCase() === s.currency.toUpperCase()
    ))
    if (matching.length === 0) return true
    return matching.some(s => { const min = resolveMin(s, salaryPrefs); return min === null || s.to >= min })
  })

  lines.push(`\n\n\n💡 Worth considering (${visibleConsider.length} offers)\n`)
  if (visibleConsider.length === 0) {
    lines.push('  No additional offers above score threshold.')
  } else {
    for (const offer of visibleConsider) {
      const salaryLines = formatSalaryEmailLines(offer.salaries ?? (offer.salary ? [offer.salary] : []), salaryPrefs)
      lines.push(titleAtCompany(offer.title, offer.company))
      for (const line of salaryLines) lines.push(`   ${line}`)
      if (offer.url) lines.push(`   🔗 ${offer.url}`)
      lines.push('')
    }
  }

  lines.push('\n\n\nNext scan: tomorrow morning')

  return lines.join('\n')
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayDDMMYYYY(): string {
  const d = new Date()
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}/${mm}/${d.getFullYear()}`
}

function titleAtCompany(title: string, company: string): string {
  if (/ @ .+$/.test(title.trimEnd())) return title.trimEnd()
  return `${title} @ ${company}`
}

function dedupeByTitleCompany<T extends { title: string }>(
  arr: T[],
  companyKey: (t: T) => string,
  scoreKey?: (t: T) => number,
): T[] {
  const best = new Map<string, T>()
  for (const item of arr) {
    const key = `${item.title}|||${companyKey(item)}`
    const existing = best.get(key)
    if (!existing || (scoreKey && scoreKey(item) > scoreKey(existing))) {
      best.set(key, item)
    }
  }
  return [...best.values()]
}

function resolveMin(salary: OfferSalary | null, prefs: SalaryPref[]): number | null {
  if (!salary || prefs.length === 0) return null
  const match = prefs.find(
    p => p.type.toLowerCase() === salary.type.toLowerCase() &&
         p.currency.toUpperCase() === salary.currency.toUpperCase()
  )
  return match?.min ?? null
}

function formatSalaryEmailLines(salaries: OfferSalary[], prefs: SalaryPref[]): string[] {
  if (salaries.length === 0) return ['salary not disclosed']
  const matching = prefs.length > 0
    ? salaries.filter(s => prefs.some(p =>
        p.type.toLowerCase() === s.type.toLowerCase() &&
        p.currency.toUpperCase() === s.currency.toUpperCase()
      ))
    : []
  const toShow = matching.length > 0 ? matching : salaries.slice(0, 1)
  const lines = toShow.map(s => formatSalaryEmailLine(s, resolveMin(s, prefs)))
  const realLines = lines.filter(l => l !== 'salary not disclosed')
  return realLines.length > 0 ? realLines : ['salary not disclosed']
}

function formatSalaryEmailLine(s: OfferSalary | null, min: number | null): string {
  if (!s || s.to == null) return 'salary not disclosed'
  const range = formatSalaryRange(s) ?? `${formatPLN(s.to)} ${s.currency}`
  if (min === null) return `💰 ${range}`
  const effectiveTo = s.unit?.toLowerCase() === 'day' ? s.to * 20 : s.to
  const delta = effectiveTo - min
  const absDelta = Math.abs(delta)
  const deltaStr = delta === 0
    ? 'exactly your minimum'
    : delta > 0
      ? `+${formatPLN(absDelta)} ${s.currency} above your minimum`
      : `-${formatPLN(absDelta)} ${s.currency} below your minimum`
  return `💰 ${range} — max ${formatPLN(s.to)} ${s.currency}, that's ${deltaStr}`
}

function formatSalaryRange(s: OfferSalary | null): string | null {
  if (!s || s.from == null || s.to == null) return null
  return `${formatPLN(s.from)} – ${formatPLN(s.to)} ${s.currency} (${s.type})`
}

function formatPLN(amount: number): string {
  return Math.round(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}
