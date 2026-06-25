import fs from 'fs'
import path from 'path'
import slugify from 'slugify'
import type { CandidateProfile } from '../types/profile'
import { env } from '../lib/env'
import { getClaudeModel } from '../lib/claudeModels'
import { prisma } from '../lib/prisma'

interface LangEntry {
  code: string
  name: string
  locale?: string
  gdpr?: string
  best_regards?: string
}

const FALLBACK_GDPR_EN = 'I hereby consent to the processing of my personal data included in this application for the purposes of the recruitment process, in accordance with the GDPR (Regulation (EU) 2016/679).'

async function getLanguageEntry(cvLanguage: string): Promise<LangEntry | undefined> {
  const row = await prisma.settings.findUnique({ where: { key: 'general_settings' } })
  if (!row) return undefined
  const languages: LangEntry[] = (JSON.parse(row.value) as { languages?: LangEntry[] }).languages ?? []
  const code = cvLanguage.toLowerCase()
  return languages.find(l => l.code === code)
    ?? languages.find(l => l.name.toLowerCase() === code)
    ?? languages.find(l => l.code === 'en')
}

const TEMPLATE_PATH = path.resolve(process.cwd(), 'src/templates/cover_letter.html')

function fmtCurrentDate(locale: string): string {
  return new Date().toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' })
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatPhone(phone: string): string {
  const match = phone.match(/^(\+\d{1,3})(\d{9})$/)
  if (!match) return phone
  const [, prefix, digits] = match
  return `${prefix} ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`
}

export async function generateCoverLetter(
  profile: CandidateProfile,
  offerText: string,
  cvLanguage: string,
  jobTitle?: string,
  companyName?: string,
  user?: { id: string; show_agent_info_in_cv: boolean },
  model?: string,
): Promise<{ html: string; filename: string; usage: { input_tokens: number; output_tokens: number }; detected_language: string }> {
  const resolvedModel = model ?? await getClaudeModel('cl_generation')
  const { basic_info } = profile
  const isPl = cvLanguage.toLowerCase() === 'pl' || cvLanguage.toLowerCase().startsWith('pol')
  const lang = cvLanguage

  const profileSummary = {
    basic_info: {
      first_name: basic_info.first_name,
      last_name: basic_info.last_name,
      experience_level: basic_info.experience_level,
      experience_since: basic_info.experience_since,
      experience_in_country_markets: basic_info.experience_in_country_markets,
      experience_in_industry: basic_info.experience_in_industry,
      cv_summary_bullets: basic_info.cv_summary_bullets,
      soft_skills: basic_info.soft_skills,
    },
    work_experience: (profile.work_experience ?? []).map(j => ({
      company: j.company,
      title: j.title,
      date_from: j.date_from,
      date_to: j.date_to ?? null,
      currently_working: j.currently_working ?? false,
      projects: (j.projects ?? []).map(p => ({
        name: p.name,
        achievements: p.achievements ?? [],
      })),
    })),
  }

  const prompt = `You are a professional cover letter writer. Detect the language of the job offer below and write the cover letter body in that same language. Do not use any other language.

The JOB OFFER section may contain UI elements, navigation, and page chrome in a different language than the actual job offer. Detect the language of the JOB OFFER ITSELF — focus on: job title, job description, requirements, responsibilities, and qualifications sections. Ignore any navigation menus, buttons, footer text, or unrelated page elements when determining the language.

CANDIDATE PROFILE:
${JSON.stringify(profileSummary, null, 2)}

JOB OFFER:
${offerText.slice(0, 3000)}

Return ONLY valid JSON (no markdown, no code fences) with this exact structure:
{
  "detected_language": "ISO 639-1 code of the detected offer language (e.g. 'en', 'de', 'pl', 'fr')",
  "body": "<p>paragraph 1</p><p>paragraph 2</p><p>paragraph 3</p>"
}

The "body" field must contain exactly 3 HTML paragraphs (each wrapped in <p> tags). No greeting, no sign-off — just the 3 <p> elements in the detected language.

Paragraph 1: Why this specific company and role — show genuine knowledge of the offer and how the candidate's background is a precise fit.
Paragraph 2: Key achievements and concrete value the candidate brings — use specific, quantified examples from their experience.
Paragraph 3: Call to action — express enthusiasm, invite to an interview, professional closing sentence.

Rules:
- Write in first person (I, my, me)
- Do NOT use em dashes (—), use a regular hyphen (-) instead
- Keep each paragraph to 3-5 sentences
- Generate the entire cover letter in the detected language of the job offer`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: resolvedModel,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(55_000),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Claude API error: ${response.status} ${errorBody}`)
  }

  const data = (await response.json()) as {
    content: Array<{ text: string }>;
    usage?: { input_tokens: number; output_tokens: number };
  }
  const rawText = data.content[0].text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  const parsed = JSON.parse(rawText) as { detected_language: string; body: string }
  const body = parsed.body
  const detectedLanguage = parsed.detected_language ?? cvLanguage

  // Contacts
  const contactParts = [
    basic_info.email ? `<a href="mailto:${esc(basic_info.email)}">${esc(basic_info.email)}</a>` : null,
    basic_info.phone ? esc(basic_info.phone) : null,
    basic_info.location?.city ? esc(basic_info.location.city) : null,
    basic_info.linkedin ? `<a href="https://${esc(basic_info.linkedin)}">${esc(basic_info.linkedin)}</a>` : null,
    basic_info.github ? `<a href="https://${esc(basic_info.github)}">${esc(basic_info.github)}</a>` : null,
  ].filter((x): x is string => x !== null)
  const contactsHtml = contactParts.join('<span class="sep">·</span>')

  const opts = { lower: true, strict: true }
  const slug = (s: string) => slugify(s, opts)
  const { first_name, last_name } = basic_info
  const filenameParts = [
    'cl',
    slug(first_name),
    slug(last_name),
    jobTitle ? slug(jobTitle) : null,
    companyName ? slug(companyName) : null,
  ].filter((p): p is string => p !== null && p.length > 0)
  const filename = filenameParts.join('-') + '.pdf'

  const langEntry = await getLanguageEntry(detectedLanguage)
  const locale = langEntry?.locale ?? 'en-US'
  const gdprText = esc(langEntry?.gdpr ?? FALLBACK_GDPR_EN)
  const bestRegards = langEntry?.best_regards ?? 'Best regards,'

  // Footer (agent info + GDPR)
  const footerParts: string[] = []
  if (user?.show_agent_info_in_cv) {
    const agentClient = await prisma.agentClient.findFirst({
      where: { user_id: user.id },
      include: { agent: true },
    })
    if (agentClient) {
      const { agent } = agentClient
      const agentPhone = agent.phone ? ` · ${esc(formatPhone(agent.phone))}` : ''
      const agentFirstName = (isPl && agent.first_name_genitive) ? agent.first_name_genitive : agent.first_name
      const agentLastName = (isPl && agent.last_name_genitive) ? agent.last_name_genitive : agent.last_name
      const agentLine = isPl
        ? `Reprezentuje mnie ${esc(agentFirstName)} ${esc(agentLastName)} z Homo Digital - ${esc(agent.email)}${agentPhone}`
        : `I am represented by ${esc(agentFirstName)} ${esc(agentLastName)} from Homo Digital - ${esc(agent.email)}${agentPhone}`
      footerParts.push(`<div class="cert-item" style="margin-bottom: 16px;">${agentLine}</div>`)
    }
  }

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8')
  let html = template
    .replace('{{LANG}}', lang)
    .replace('{{CL_TITLE}}', filename.replace('.pdf', ''))
    .replace(/\{\{FULL_NAME\}\}/g, `${esc(first_name)} ${esc(last_name)}`)
    .replace('{{TARGET_ROLE}}', esc(jobTitle ?? ''))
    .replace('{{CONTACTS}}', contactsHtml)
    .replace('{{CITY}}', esc(basic_info.location?.city ?? ''))
    .replace('{{DATE}}', fmtCurrentDate(locale))
    .replace('{{JOB_TITLE}}', esc(jobTitle ?? ''))
    .replace('{{COMPANY_NAME}}', esc(companyName ?? ''))
    .replace('{{BODY}}', body)
    .replace('{{BEST_REGARDS}}', bestRegards)
    .replace('{{FOOTER_NOTES}}', footerParts.join('\n'))
    .replace('{{GDPR_CONSENT}}', gdprText)

  html = html.replace(/—/g, '-')

  return { html, filename, usage: { input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0 }, detected_language: detectedLanguage }
}
