import type { CandidateProfile } from '../types/profile'
import { env } from '../lib/env'

// ─── Date formatting ──────────────────────────────────────────────────────────

const MONTHS_PL = ['Sty', 'Lut', 'Mar', 'Kwi', 'Maj', 'Cze', 'Lip', 'Sie', 'Wrz', 'Paź', 'Lis', 'Gru']

function fmtDate(raw: string | null | undefined): string {
  if (!raw) return 'obecnie'
  const [year, mm] = raw.split('-')
  const m = parseInt(mm ?? '1', 10)
  return `${MONTHS_PL[m - 1] ?? ''} ${year}`.trim()
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ─── Claude JSON response types ───────────────────────────────────────────────

interface CvProject {
  name: string
  technologies: string[]
  highlighted_achievements: string[]
}

interface CvJob {
  company: string
  title: string
  date_from: string
  date_to: string | null
  work_model?: string
  industry?: string
  projects: CvProject[]
}

interface CvOwnProject {
  name: string
  url?: string | null
  technologies: string[]
  description: string
}

interface CvCert {
  name: string
  issuer?: string
  date?: string
}

interface CvContent {
  target_role: string
  summary: string
  highlighted_skills: string[]
  work_experience: CvJob[]
  own_projects: CvOwnProject[]
  certifications: CvCert[]
}

// ─── HTML builder ─────────────────────────────────────────────────────────────

function buildHtml(cv: CvContent, profile: CandidateProfile): string {
  const { basic_info, education, own_projects: profileProjects, technologies } = profile

  // Header contacts
  const contactParts = [
    basic_info.email
      ? `<a href="mailto:${esc(basic_info.email)}">${esc(basic_info.email)}</a>`
      : null,
    basic_info.phone ? esc(basic_info.phone) : null,
    basic_info.location?.city ? esc(basic_info.location.city) : null,
    basic_info.linkedin
      ? `<a href="https://${esc(basic_info.linkedin)}">${esc(basic_info.linkedin)}</a>`
      : null,
    basic_info.github
      ? `<a href="https://${esc(basic_info.github)}">${esc(basic_info.github)}</a>`
      : null,
  ].filter((x): x is string => x !== null)
  const contactsHtml = contactParts.join('<span class="sep">·</span>')

  // Experience
  const expHtml = cv.work_experience
    .map(job => {
      const projHtml = job.projects
        .map(p => {
          const techsHtml = p.technologies.length
            ? `<div class="project-techs">${p.technologies.map(t => esc(t)).join(' · ')}</div>`
            : ''
          const achieveHtml = p.highlighted_achievements.length
            ? `<ul class="project-achievements">${p.highlighted_achievements.map(a => `<li>${esc(a)}</li>`).join('')}</ul>`
            : ''
          return `<div class="project">
          <div class="project-name">${esc(p.name)}</div>
          ${techsHtml}${achieveHtml}
        </div>`
        })
        .join('\n')

      const meta = job.industry ? esc(job.industry) : ''
      return `<div class="job">
        <div class="job-header">
          <span class="job-title">${esc(job.title)}</span>
          <span class="job-company">@ ${esc(job.company)}</span>
          <span class="job-dates">${fmtDate(job.date_from)} – ${fmtDate(job.date_to)}</span>
          ${meta ? `<span class="job-meta">${meta}</span>` : ''}
        </div>
        ${projHtml}
      </div>`
    })
    .join('\n')

  // Own projects section — only if Claude selected any
  const visibleProfileProjects = (profileProjects ?? []).filter(p => p.status !== 'private')
  const showOwnProjects = visibleProfileProjects.length > 0 && cv.own_projects.length > 0
  const ownProjHtml = showOwnProjects
    ? cv.own_projects
        .map(p => {
          const url = p.url
          const nameInner = url
            ? `<a href="${url.startsWith('http') ? '' : 'https://'}${esc(url)}">${esc(p.name)}</a>`
            : esc(p.name)
          const techsHtml = p.technologies.length
            ? `<div class="own-project-techs">${p.technologies.map(t => esc(t)).join(' · ')}</div>`
            : ''
          return `<div class="own-project">
          <div class="own-project-name">${nameInner}</div>
          ${techsHtml}
          <div class="own-project-desc">${esc(p.description)}</div>
        </div>`
        })
        .join('\n')
    : ''

  // Skills — highlighted first, then profile categories
  const highlightedPillsHtml = cv.highlighted_skills
    .map(s => `<span class="pill highlighted">${esc(s)}</span>`)
    .join('')

  const categorySkillsHtml = Object.entries(technologies)
    .filter(([, techs]) => techs.length > 0)
    .map(
      ([cat, techs]) =>
        `<div class="skills-row">
          <div class="skills-label">${esc(cat)}</div>
          <div class="skills-pills">${techs.map(t => `<span class="pill">${esc(t.name)}</span>`).join('')}</div>
        </div>`,
    )
    .join('\n')

  // Education
  const eduHtml = (education ?? [])
    .map(
      e =>
        `<div class="education-item">
        <div class="edu-institution">${esc(e.institution)}</div>
        ${e.degree || e.field ? `<div class="edu-degree">${[e.degree, e.field].filter(Boolean).map(s => esc(s!)).join(', ')}</div>` : ''}
        <div class="edu-dates">${fmtDate(e.date_from)} – ${fmtDate(e.date_to)}</div>
      </div>`,
    )
    .join('\n')

  // Languages
  const langsText = (basic_info.languages ?? [])
    .map(l => l.charAt(0).toUpperCase() + l.slice(1))
    .map(esc)
    .join(', ')

  // Certifications
  const certHtml = cv.certifications
    .map(c => {
      const meta = [c.issuer, c.date ? fmtDate(c.date) : null].filter(Boolean).map(s => esc(s!)).join(', ')
      return `<div class="cert-item">
        <span class="cert-name">${esc(c.name)}</span>
        ${meta ? `<span class="cert-meta"> — ${meta}</span>` : ''}
      </div>`
    })
    .join('\n')

  return `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CV — ${esc(basic_info.first_name)} ${esc(basic_info.last_name)}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 13px; color: #1a1a1a; background: #fff; line-height: 1.55; }
.cv { max-width: 820px; margin: 0 auto; padding: 40px 48px; }
h1 { font-size: 26px; font-weight: 700; color: #111; letter-spacing: -0.3px; }
.target-role { font-size: 14px; color: #2563eb; font-weight: 600; margin: 3px 0 8px; }
.contacts { font-size: 12px; color: #555; display: flex; flex-wrap: wrap; }
.contacts a { color: #555; text-decoration: none; }
.sep { margin: 0 8px; color: #ccc; }
h2 { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #2563eb; border-bottom: 1.5px solid #e5e7eb; padding-bottom: 4px; margin: 24px 0 12px; }
.job { margin-bottom: 18px; }
.job-header { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.job-title { font-weight: 600; font-size: 13.5px; }
.job-company { color: #555; font-size: 13px; }
.job-dates { margin-left: auto; font-size: 12px; color: #666; white-space: nowrap; }
.job-meta { width: 100%; font-size: 11.5px; color: #777; margin-top: 1px; }
.project { margin: 0 0 10px 12px; padding-left: 10px; border-left: 2px solid #e5e7eb; }
.project-name { font-weight: 600; font-size: 12.5px; margin-bottom: 2px; }
.project-techs { font-size: 11.5px; color: #2563eb; margin-bottom: 4px; }
.project-achievements { margin: 0; padding-left: 16px; }
.project-achievements li { font-size: 12.5px; color: #333; margin-bottom: 2px; }
.own-projects { display: flex; flex-direction: column; gap: 10px; }
.own-project-name { font-weight: 600; font-size: 13px; }
.own-project-name a { color: #2563eb; text-decoration: none; }
.own-project-techs { font-size: 11.5px; color: #2563eb; margin: 2px 0; }
.own-project-desc { font-size: 12.5px; color: #333; }
.highlighted-row { margin-bottom: 10px; }
.highlighted-label { font-size: 11px; font-weight: 700; color: #1d4ed8; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 4px; }
.skills-row { margin-bottom: 8px; }
.skills-label { font-size: 11px; font-weight: 600; color: #555; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 3px; }
.skills-pills { display: flex; flex-wrap: wrap; gap: 4px; }
.pill { background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 4px; padding: 2px 8px; font-size: 12px; color: #374151; }
.pill.highlighted { background: #eff6ff; border-color: #bfdbfe; color: #1d4ed8; font-weight: 500; }
.education-item { margin-bottom: 10px; }
.edu-institution { font-weight: 600; font-size: 13px; }
.edu-degree { color: #333; font-size: 12.5px; }
.edu-dates { font-size: 12px; color: #666; margin-top: 1px; }
.cert-item { margin-bottom: 5px; font-size: 12.5px; }
.cert-name { font-weight: 500; }
.cert-meta { color: #666; }
@media print {
  .cv { padding: 20px 24px; }
  h2 { margin-top: 16px; }
  a { color: inherit !important; text-decoration: none !important; }
}
</style>
</head>
<body>
<div class="cv">
  <header>
    <h1>${esc(basic_info.first_name)} ${esc(basic_info.last_name)}</h1>
    <div class="target-role">${esc(cv.target_role)}</div>
    <div class="contacts">${contactsHtml}</div>
  </header>

  <h2>Podsumowanie</h2>
  <p>${esc(cv.summary)}</p>

  <h2>Doświadczenie</h2>
  ${expHtml}

  ${showOwnProjects ? `<h2>Projekty własne</h2>
  <div class="own-projects">
  ${ownProjHtml}
  </div>` : ''}

  <h2>Umiejętności</h2>
  ${cv.highlighted_skills.length ? `<div class="highlighted-row">
    <div class="highlighted-label">Kluczowe dla tej roli</div>
    <div class="skills-pills">${highlightedPillsHtml}</div>
  </div>` : ''}
  ${categorySkillsHtml}

  <h2>Wykształcenie</h2>
  ${eduHtml}

  <h2>Języki</h2>
  <p>${langsText}</p>

  ${cv.certifications.length ? `<h2>Certyfikaty</h2>
  ${certHtml}` : ''}
</div>
</body>
</html>`
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function generateCV(
  profile: CandidateProfile,
  offerText: string,
  cvLanguage: string,
): Promise<string> {
  const visibleOwnProjects = (profile.own_projects ?? []).filter(p => p.status !== 'private')

  const profileForClaude = {
    basic_info: { first_name: profile.basic_info.first_name, last_name: profile.basic_info.last_name },
    work_experience: profile.work_experience ?? [],
    own_projects: visibleOwnProjects,
    certifications: profile.certifications ?? [],
    technologies: profile.technologies,
  }

  const prompt = `You are a professional CV writer. Analyse the candidate profile and job offer, then return a JSON object with tailored CV content.

CANDIDATE PROFILE:
${JSON.stringify(profileForClaude, null, 2)}

JOB OFFER (${cvLanguage}):
${offerText.slice(0, 3000)}

Return ONLY valid JSON (no markdown, no code fences, no explanation) matching this exact structure:
{
  "target_role": "job title tailored to this offer",
  "summary": "2-3 sentence professional summary in ${cvLanguage} tailored to this offer",
  "highlighted_skills": ["skill1", "skill2"],
  "work_experience": [
    {
      "company": "company name from profile",
      "title": "job title from profile",
      "date_from": "YYYY-MM",
      "date_to": "YYYY-MM or null if current",
      "work_model": "Remote/Hybrid/Office",
      "industry": "industry name",
      "projects": [
        {
          "name": "project name",
          "technologies": ["tech1", "tech2"],
          "highlighted_achievements": ["most relevant achievement for this offer"]
        }
      ]
    }
  ],
  "own_projects": [
    {
      "name": "project name",
      "url": "url or null",
      "technologies": ["tech1", "tech2"],
      "description": "1 sentence tailored to this offer in ${cvLanguage}"
    }
  ],
  "certifications": [
    { "name": "cert name", "issuer": "issuer or null", "date": "YYYY-MM or null" }
  ]
}

Rules:
- highlighted_skills: 6–10 skills from the job offer requirements that match the candidate's profile
- work_experience: include ALL jobs; per job select 1–2 most relevant projects with 1–2 achievements each
- own_projects: include all provided projects with a tailored 1-sentence description in ${cvLanguage}
- certifications: include only if relevant to this offer, otherwise return []
- date_to: null means currently employed there
- dates must be in YYYY-MM format (e.g. "2021-03")`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    console.error('[cvGenerator] Claude API error status:', response.status)
    console.error('[cvGenerator] Claude API error body:', errorBody)
    console.error('[cvGenerator] prompt length (chars):', prompt.length)
    throw new Error(`Claude API error: ${response.status} ${errorBody}`)
  }

  const data = (await response.json()) as { content: Array<{ text: string }> }
  const raw = data.content[0].text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  const cv = JSON.parse(raw) as CvContent
  return buildHtml(cv, profile)
}
