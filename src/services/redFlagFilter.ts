import type { Offer } from '@prisma/client'
import type { CandidateProfile } from '../types/profile'
import { getBestSalary } from '../lib/offers'

// Returns an array of human-readable rejection reasons.
// Empty array = offer passes all red flags and is eligible for scoring.
export function filterRedFlags(profile: CandidateProfile, offer: Offer): string[] {
  const reasons: string[] = []

  for (const flag of profile.red_flags) {
    const category = flag.category.toLowerCase()
    const desc = flag.description.toLowerCase()

    if (['technology', 'tech', 'stack', 'technologies'].includes(category)) {
      const forbidden = desc.split(/[,;]/).map((t) => t.trim().toLowerCase()).filter(Boolean)
      const offerTechs = offer.required_skills.map((s) => s.toLowerCase())
      for (const tech of forbidden) {
        const pattern = new RegExp(
          `(^|[^a-z0-9])${tech.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`
        )
        if (offerTechs.some((o) => o === tech || pattern.test(o))) {
          reasons.push(`Requires ${tech} (excluded: ${flag.description})`)
          break
        }
      }
    }

    if (['salary', 'compensation', 'pay'].includes(category)) {
      const numMatch = desc.match(/(\d[\d\s]*\d|\d+)/)
      if (numMatch) {
        const minSalary = parseInt(numMatch[1].replace(/\s/g, ''), 10)
        const offerMax = getBestSalary(offer)
        if (offerMax !== null && offerMax < minSalary) {
          reasons.push(
            `Salary ${offerMax.toLocaleString()} PLN below minimum ${minSalary.toLocaleString()} PLN`
          )
        }
      }
    }

    if (['work_model', 'remote', 'location', 'workplace'].includes(category)) {
      const workplaceType = offer.workplace_type?.toLowerCase()
      if (!workplaceType) continue
      if (
        (desc.includes('no office') || desc.includes('remote only') || desc.includes('only remote')) &&
        workplaceType === 'office'
      ) {
        reasons.push(`Office work required (excluded: ${flag.description})`)
      }
      if (
        (desc.includes('no remote') || desc.includes('office only')) &&
        workplaceType === 'remote'
      ) {
        reasons.push(`Remote-only role (excluded: ${flag.description})`)
      }
    }
  }

  return reasons
}
