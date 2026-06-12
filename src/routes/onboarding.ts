import { Router } from 'express'
import { z } from 'zod'
import multer from 'multer'
import { PDFParse } from 'pdf-parse'
import { validateJwt } from '../middleware/validateJwt'
import { env } from '../lib/env'
import { AppError } from '../lib/errors'

export const onboardingRouter = Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true)
    } else {
      cb(new Error('Only PDF files are accepted'))
    }
  },
})

const PROFILE_SCHEMA = `{
  "basic_info": {
    "first_name": "string | null",
    "last_name": "string | null",
    "email": "string | null",
    "phone": "string | null",
    "gender": "M | F | null",
    "github": "string | null",
    "linkedin": "string | null",
    "location": {
      "city": "string | null",
      "country_code": "ISO 2-letter code | null",
      "max_distance_km": "number | null"
    },
    "languages": [{ "name": "string", "level": "A1|A2|B1|B2|C1|C2|native" }],
    "experience_level": "junior | mid | senior | lead",
    "experience_since": "4-digit year number | null",
    "job_search_status": "actively_looking",
    "soft_skills": ["string"],
    "cv_summary_bullets": ["3 concise achievement-focused bullet strings"],
    "experience_in_industry": ["string"],
    "experience_in_country_markets": ["string"]
  },
  "skills": {
    "Frontend": [{ "name": "React", "since": 2020 }],
    "Backend": [{ "name": "Node.js", "since": 2019 }]
  },
  "work_experience": [
    {
      "title": "string",
      "company": "string",
      "date_from": "YYYY-MM",
      "date_to": "YYYY-MM | null if current",
      "industry": "string | null",
      "location": "string | null",
      "work_model": "remote | hybrid | onsite | null",
      "company_type": "string | null",
      "projects": [
        {
          "name": "string",
          "role": "string | null",
          "skills": ["string"],
          "team_size": "number | null",
          "achievements": ["string"]
        }
      ]
    }
  ],
  "education": [
    {
      "institution": "string",
      "degree": "string | null",
      "field": "string | null",
      "date_from": "YYYY-MM | null",
      "date_to": "YYYY-MM | null",
      "gpa": "string | null",
      "thesis": "string | null"
    }
  ],
  "certifications": [
    { "name": "string", "issuer": "string | null", "date": "YYYY-MM | null", "url": "string | null" }
  ],
  "own_projects": [
    { "name": "string", "url": "string | null", "skills": ["string"], "achievements": ["string"] }
  ],
  "red_flags": [],
  "preferences": {
    "salary": [{ "min": "number", "type": "contract | permanent", "currency": "string" }],
    "work_model": ["remote | hybrid | office"],
    "target_role": ["string"],
    "company_type": ["string"],
    "company_type_excluded": ["string"],
    "employment_type": ["contract | permanent"],
    "industries": ["string"],
    "markets": ["string"],
    "learning_goals": ["string"],
    "max_office_days_per_week": "number | null",
    "office_location_cities": ["string"]
  }
}`

onboardingRouter.post('/prepare-profile', validateJwt, upload.single('cv'), async (req, res) => {
  if (!req.file) {
    throw new AppError(422, 'INVALID_REQUEST', 'Missing required file: cv (PDF)')
  }

  console.log(`[prepare-profile] PDF buffer size: ${req.file.buffer.length} bytes`)

  let cvText: string
  try {
    const parser = new PDFParse({ data: new Uint8Array(req.file.buffer) })
    const parsed = await parser.getText()
    cvText = parsed.text.trim()
    console.log(`[prepare-profile] PDF text extracted successfully, length: ${cvText.length} chars`)
  } catch (err) {
    console.error('[prepare-profile] pdf-parse error:', err)
    throw new AppError(422, 'INVALID_REQUEST', 'Could not extract text from PDF')
  }

  if (!cvText) {
    throw new AppError(422, 'INVALID_REQUEST', 'PDF contains no extractable text')
  }

  const prompt = `You are a CV parser. Extract structured data from the CV text below and return it as a JSON object matching the exact schema provided.

SCHEMA:
${PROFILE_SCHEMA}

RULES:
- Return ONLY valid JSON — no markdown, no code blocks, no explanation
- Use null for fields that cannot be determined from the CV
- Use empty arrays [] for list fields with no data
- experience_level: junior = 0-2 yrs, mid = 2-5 yrs, senior = 5-8 yrs, lead = 8+ yrs
- experience_since: infer the year from the candidate's earliest job date_from
- job_search_status: always "actively_looking"
- red_flags: always empty array []
- skills: group all technologies by category (Frontend, Backend, Mobile, Databases, Languages, Cloud & Infra, Tools)
- work_experience.projects: model each role or major responsibility as a project entry; list concrete achievements as bullets
- cv_summary_bullets: exactly 3 concise achievement-focused bullets summarising the candidate
- soft_skills: extract from explicit mentions or infer from CV descriptions
- preferences.salary: extract if salary expectations are mentioned, otherwise []
- github: always prefix with "https://" if not already present (e.g. "github.com/user" → "https://github.com/user")
- linkedin: always prefix with "https://" if not already present (e.g. "linkedin.com/in/user" → "https://linkedin.com/in/user")

CV TEXT:
${cvText.slice(0, 12000)}`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(55_000),
  })

  if (!response.ok) {
    const errBody = await response.text()
    throw new Error(`Claude API error ${response.status}: ${errBody}`)
  }

  const data = (await response.json()) as { content: Array<{ text: string }> }
  console.log('[prepare-profile] Claude response:', JSON.stringify(data))
  const rawText = data.content[0].text.trim()

  let profile: unknown
  try {
    profile = JSON.parse(rawText)
    console.log('[prepare-profile] parsed profile keys:', Object.keys(profile as object))
  } catch {
    throw new AppError(500, 'INTERNAL_ERROR', 'Profile parsing failed — Claude returned invalid JSON')
  }

  const p = profile as { basic_info?: { github?: string | null; linkedin?: string | null } }
  if (p.basic_info?.github && !p.basic_info.github.startsWith('http')) {
    p.basic_info.github = `https://${p.basic_info.github}`
  }
  if (p.basic_info?.linkedin && !p.basic_info.linkedin.startsWith('http')) {
    p.basic_info.linkedin = `https://${p.basic_info.linkedin}`
  }

  return res.json({ profile })
})

const ReviewBodySchema = z.object({
  profile: z.record(z.string(), z.unknown()),
})

const ReviewResponseSchema = z.object({
  verdict: z.enum(['Strong profile', 'Good profile, a few gaps', 'Needs improvement', 'Incomplete profile']),
  verdict_explanation: z.string(),
  strengths: z.array(z.string()),
  improvements: z.array(z.string()),
  missing: z.array(z.string()),
  suggested_certifications: z.array(z.object({ name: z.string(), reason: z.string() })),
  tips: z.array(z.string()),
})

type ReviewResponse = z.infer<typeof ReviewResponseSchema>

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function bulletSection(title: string, items: string[], headerCss: string, dotCss: string): string {
  if (!items.length) return ''
  return `
    <div class="bg-white rounded-xl border border-gray-200 p-6">
      <h2 class="text-base font-semibold ${headerCss} mb-3">${title}</h2>
      <ul class="space-y-2">
        ${items.map(i => `<li class="flex gap-2 text-gray-700"><span class="${dotCss} mt-1.5 h-2 w-2 flex-shrink-0 rounded-full"></span><span>${esc(i)}</span></li>`).join('\n        ')}
      </ul>
    </div>`
}

function buildHtml(r: ReviewResponse): string {
  const verdictCss: Record<string, string> = {
    'Strong profile':            'bg-green-100 text-green-800',
    'Good profile, a few gaps':  'bg-blue-100 text-blue-800',
    'Needs improvement':         'bg-orange-100 text-orange-800',
    'Incomplete profile':        'bg-red-100 text-red-800',
  }
  const badge = verdictCss[r.verdict] ?? 'bg-gray-100 text-gray-800'

  const certsHtml = r.suggested_certifications.length ? `
    <div class="bg-white rounded-xl border border-gray-200 p-6">
      <h2 class="text-base font-semibold text-blue-700 mb-3">Suggested Certifications</h2>
      <ul class="space-y-3">
        ${r.suggested_certifications.map(c => `
        <li class="flex gap-2 text-gray-700">
          <span class="bg-blue-400 mt-1.5 h-2 w-2 flex-shrink-0 rounded-full"></span>
          <span><span class="font-medium">${esc(c.name)}</span> — ${esc(c.reason)}</span>
        </li>`).join('')}
      </ul>
    </div>` : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Homo Digital - Profile Review</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen py-10 px-4">
  <div class="max-w-3xl mx-auto space-y-5">
    <div class="flex items-center gap-3">
      <h1 class="text-2xl font-bold text-gray-900">Profile Review</h1>
    </div>

    <div class="bg-white rounded-xl border border-gray-200 p-6">
      <span class="inline-block px-3 py-1 rounded-full text-sm font-semibold ${badge} mb-3">${esc(r.verdict)}</span>
      <p class="text-gray-700">${esc(r.verdict_explanation)}</p>
    </div>

    ${bulletSection('Strengths', r.strengths, 'text-green-700', 'bg-green-400')}
    ${bulletSection('Improvements', r.improvements, 'text-orange-700', 'bg-orange-400')}
    ${bulletSection('Missing Important Info', r.missing, 'text-red-700', 'bg-red-400')}
    ${certsHtml}
    ${bulletSection('Profile Tips', r.tips, 'text-gray-600', 'bg-gray-400')}
  </div>
</body>
</html>`
}

onboardingRouter.post('/review-profile', validateJwt, async (req, res) => {
  const parsed = ReviewBodySchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(422, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid request body')
  }

  const prompt = `You are a professional career coach reviewing a candidate's structured profile JSON for a job-matching platform.

Analyze the profile below and return a JSON object matching the exact schema provided.

PROFILE JSON:
${JSON.stringify(parsed.data.profile, null, 2)}

SCHEMA:
{
  "verdict": "Strong profile" | "Good profile, a few gaps" | "Needs improvement" | "Incomplete profile",
  "verdict_explanation": "2-3 sentences referencing actual profile data",
  "strengths": ["string"],
  "improvements": ["string"],
  "missing": ["string"],
  "suggested_certifications": [{ "name": "string", "reason": "string" }],
  "tips": ["string"]
}

RULES:
- Be specific and actionable — reference the candidate's actual job titles, skills, companies, and dates
- Do not mention any completeness percentage
- Return ONLY valid JSON — no markdown, no code fences, no explanation`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(55_000),
  })

  if (!response.ok) {
    const errBody = await response.text()
    throw new Error(`Claude API error ${response.status}: ${errBody}`)
  }

  const data = (await response.json()) as { content: Array<{ text: string }> }
  const rawText = data.content[0].text.trim()

  let review: ReviewResponse
  try {
    const reviewParsed = ReviewResponseSchema.safeParse(JSON.parse(rawText))
    if (!reviewParsed.success) {
      throw new Error(reviewParsed.error.issues[0]?.message)
    }
    review = reviewParsed.data
  } catch {
    throw new AppError(500, 'INTERNAL_ERROR', 'Profile review parsing failed — Claude returned invalid JSON')
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(buildHtml(review))
})
