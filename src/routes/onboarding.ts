import { Router } from 'express'
import multer from 'multer'
import pdfParse from 'pdf-parse'
import { validateSupabaseJwt } from '../middleware/validateSupabaseJwt'
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
    "github": "string | null (path only, no https://)",
    "linkedin": "string | null (path only, no https://)",
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
    "salary": [{ "min": "number", "type": "b2b | permanent", "currency": "string" }],
    "work_model": ["remote | hybrid | office"],
    "target_role": ["string"],
    "company_type": ["string"],
    "company_type_excluded": ["string"],
    "employment_type": ["b2b | permanent"],
    "industries": ["string"],
    "markets": ["string"],
    "learning_goals": ["string"],
    "max_office_days_per_week": "number | null",
    "office_location_cities": ["string"]
  }
}`

onboardingRouter.post('/prepare-profile', validateSupabaseJwt, upload.single('cv'), async (req, res) => {
  if (!req.file) {
    throw new AppError(422, 'INVALID_REQUEST', 'Missing required file: cv (PDF)')
  }

  let cvText: string
  try {
    const parsed = await pdfParse(req.file.buffer)
    cvText = parsed.text.trim()
  } catch {
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
  const rawText = data.content[0].text.trim()

  let profile: unknown
  try {
    profile = JSON.parse(rawText)
  } catch {
    throw new AppError(500, 'INTERNAL_ERROR', 'Profile parsing failed — Claude returned invalid JSON')
  }

  return res.json({ profile })
})
