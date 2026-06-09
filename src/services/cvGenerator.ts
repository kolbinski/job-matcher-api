import fs from 'fs';
import path from 'path';
import slugify from 'slugify';
import type { CandidateProfile } from '../types/profile';
import { env } from '../lib/env';
import { prisma } from '../lib/prisma';

const TEMPLATE_PATH = path.resolve(process.cwd(), 'src/templates/cv.html');

// ─── Date formatting ──────────────────────────────────────────────────────────

const MONTHS_PL = [
  'Sty',
  'Lut',
  'Mar',
  'Kwi',
  'Maj',
  'Cze',
  'Lip',
  'Sie',
  'Wrz',
  'Paź',
  'Lis',
  'Gru',
];
const MONTHS_EN = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function fmtDate(raw: string | null | undefined, lang: string): string {
  const isPolish =
    lang.toLowerCase() === 'pl' || lang.toLowerCase().startsWith('pol');
  if (!raw) return isPolish ? 'obecnie' : 'present';
  const [year, mm] = raw.split('-');
  const m = parseInt(mm ?? '1', 10);
  const months = isPolish ? MONTHS_PL : MONTHS_EN;
  return `${months[m - 1] ?? ''} ${year}`.trim();
}

function fmtYear(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.split('-')[0] ?? '';
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Claude JSON response types ───────────────────────────────────────────────

interface CvProject {
  name: string;
  skills: string[];
  highlighted_achievements: string[];
}

interface CvJob {
  company: string;
  title: string;
  date_from: string;
  date_to: string | null;
  work_model?: string;
  industry?: string;
  projects: CvProject[];
}

interface CvOwnProject {
  name: string;
  url?: string | null;
  skills: string[];
  description: string;
}

interface CvCert {
  name: string;
  issuer?: string;
  date?: string;
}

interface CvContent {
  target_role: string;
  summary: string;
  highlighted_skills: string[];
  work_experience: CvJob[];
  own_projects: CvOwnProject[];
  certifications: CvCert[];
}

// ─── Work model / location formatting ────────────────────────────────────────

function formatWorkModel(work_model?: string, location?: string): string {
  if (work_model === 'remote') return 'Remote';
  if (work_model === 'hybrid' && location) return `Hybrid · ${location}`;
  if (work_model === 'onsite' && location) return location;
  if (location) return location;
  return '';
}

// ─── Section labels ───────────────────────────────────────────────────────────

const SECTION_LABELS = {
  pl: {
    summary: 'Podsumowanie',
    experience: 'Doświadczenie',
    own_projects: 'Projekty własne',
    skills: 'Umiejętności',
    highlighted: 'Kluczowe dla tej roli',
    education: 'Wykształcenie',
    languages: 'Języki',
    certifications: 'Certyfikaty',
  },
  en: {
    summary: 'Summary',
    experience: 'Experience',
    own_projects: 'Own projects',
    skills: 'Skills',
    highlighted: 'Highlighted for this role',
    education: 'Education',
    languages: 'Languages',
    certifications: 'Certifications',
  },
};

// ─── HTML builder ─────────────────────────────────────────────────────────────

function buildHtml(
  cv: CvContent,
  profile: CandidateProfile,
  cvLanguage: string,
): string {
  const langKey =
    cvLanguage.toLowerCase() === 'pl' ||
    cvLanguage.toLowerCase().startsWith('pol')
      ? 'pl'
      : 'en';
  const labels = SECTION_LABELS[langKey];

  const {
    basic_info,
    education,
    own_projects: profileProjects,
    skills: technologies,
  } = profile;

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
  ].filter((x): x is string => x !== null);
  const contactsHtml = contactParts.join('<span class="sep">·</span>');

  // Experience
  const expHtml = cv.work_experience
    .map(job => {
      const projHtml = job.projects
        .map(p => {
          const techsHtml = p.skills.length
            ? `<div class="project-techs">${p.skills.map(t => esc(t)).join(' · ')}</div>`
            : '';
          const achieveHtml = p.highlighted_achievements.length
            ? `<ul class="project-achievements">${p.highlighted_achievements.map(a => `<li>${esc(a)}</li>`).join('')}</ul>`
            : '';
          return `<div class="project">
          ${p.name ? `<div class="project-name">${esc(p.name)}</div>` : ''}
          ${techsHtml}${achieveHtml}
        </div>`;
        })
        .join('\n');

      const profileJob = (profile.work_experience ?? []).find(
        pj => pj.company === job.company,
      );
      const workModelStr = formatWorkModel(
        profileJob?.work_model,
        profileJob?.location,
      );
      const metaParts = [
        job.industry ? esc(job.industry) : null,
        workModelStr || null,
      ].filter((x): x is string => x !== null);
      const metaHtml = metaParts.length
        ? `<span class="job-company-meta"> · ${metaParts.join(' · ')}</span>`
        : '';
      return `<div class="job">
        <div class="job-header">
          <span>
            <span class="job-company-name">${esc(job.company)}</span>${metaHtml}
          </span>
          <span class="job-dates">${fmtDate(job.date_from, cvLanguage)} – ${fmtDate(job.date_to, cvLanguage)}</span>
          <span class="job-title">${esc(job.title)}</span>
        </div>
        ${projHtml}
      </div>`;
    })
    .join('\n');

  // Own projects section — only if Claude selected any
  const showOwnProjects =
    (profileProjects ?? []).length > 0 && cv.own_projects.length > 0;
  const ownProjectsSection = showOwnProjects
    ? `<h2>${labels.own_projects}</h2>
  <div class="own-projects">
  ${cv.own_projects
    .map(p => {
      const urlSpan = p.url
        ? ` <span style="font-weight:400; color:#4a4a4a; font-size:12px;">· ${esc(p.url)}</span>`
        : '';
      const techsHtml = p.skills.length
        ? `<div class="own-project-techs">${p.skills.map(t => esc(t)).join(' · ')}</div>`
        : '';
      return `<div class="own-project">
          <div class="own-project-name">${esc(p.name)}${urlSpan}</div>
          ${techsHtml}
          <div class="own-project-desc">${esc(p.description)}</div>
        </div>`;
    })
    .join('\n')}
  </div>`
    : '';

  // Skills — highlighted first, then profile categories
  const highlightedSkillsHtml = cv.highlighted_skills.length
    ? `<div class="highlighted-row">
    <div class="highlighted-label">${labels.highlighted}</div>
    <div class="skills-pills">${cv.highlighted_skills.map(s => `<span class="pill highlighted">${esc(s)}</span>`).join('')}</div>
  </div>`
    : '';

  const categorySkillsHtml = Object.entries(technologies)
    .filter(([, techs]) => techs.length > 0)
    .map(
      ([cat, techs]) =>
        `<div class="skills-row">
          <div class="skills-label">${esc(cat)}</div>
          <div class="skills-pills">${techs.map(t => `<span class="pill">${esc(t.name)}</span>`).join('')}</div>
        </div>`,
    )
    .join('\n');

  // Education
  const eduHtml = (education ?? [])
    .map(e => {
      const dateRange = [fmtYear(e.date_from), fmtYear(e.date_to)]
        .filter(Boolean)
        .join(' – ');
      return `<div class="education-item">
        <div style="display:flex; justify-content:space-between;">
          <span class="edu-institution">${esc(e.institution)}</span>
          <span class="edu-dates">${dateRange}</span>
        </div>
        ${
          e.degree || e.field
            ? `<div class="edu-degree">${[e.degree, e.field]
                .filter(Boolean)
                .map(s => esc(s!))
                .join(', ')}</div>`
            : ''
        }
      </div>`;
    })
    .join('\n');

  // Languages
  const langsText = (basic_info.languages ?? [])
    .map(l =>
      esc(`${l.name.charAt(0).toUpperCase() + l.name.slice(1)} (${l.level})`),
    )
    .join(', ');

  // Certifications
  const certificationsSection = cv.certifications.length
    ? `<h2>${labels.certifications}</h2>
  ${cv.certifications
    .map(c => {
      const meta = [c.issuer, c.date ? fmtDate(c.date, cvLanguage) : null]
        .filter(Boolean)
        .map(s => esc(s!))
        .join(', ');
      return `<div class="cert-item">
        <span class="cert-name">${esc(c.name)}</span>
        ${meta ? `<span class="cert-meta"> — ${meta}</span>` : ''}
      </div>`;
    })
    .join('\n')}`
    : '';

  const fullName = `${esc(basic_info.first_name)} ${esc(basic_info.last_name)}`;
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');

  return template
    .replace('{{FULL_NAME}}', fullName)
    .replace('{{TARGET_ROLE}}', esc(cv.target_role))
    .replace('{{CONTACTS}}', contactsHtml)
    .replace('{{LABEL_SUMMARY}}', labels.summary)
    .replace('{{SUMMARY}}', esc(cv.summary))
    .replace('{{LABEL_EXPERIENCE}}', labels.experience)
    .replace('{{EXPERIENCE}}', expHtml)
    .replace('{{OWN_PROJECTS_SECTION}}', ownProjectsSection)
    .replace('{{HIGHLIGHTED_SKILLS}}', highlightedSkillsHtml)
    .replace('{{LABEL_SKILLS}}', labels.skills)
    .replace('{{CATEGORY_SKILLS}}', categorySkillsHtml)
    .replace('{{LABEL_EDUCATION}}', labels.education)
    .replace('{{EDUCATION}}', eduHtml)
    .replace('{{LABEL_LANGUAGES}}', labels.languages)
    .replace('{{LANGUAGES}}', langsText)
    .replace('{{CERTIFICATIONS_SECTION}}', certificationsSection);
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function generateCV(
  profile: CandidateProfile,
  offerText: string,
  cvLanguage: string,
  jobTitle?: string,
  companyName?: string,
  user?: { id: string; show_agent_info_in_cv: boolean; gender: string | null },
): Promise<{ html: string; filename: string }> {
  const profileForClaude = {
    basic_info: {
      first_name: profile.basic_info.first_name,
      last_name: profile.basic_info.last_name,
      experience_level: profile.basic_info.experience_level,
      experience_since: profile.basic_info.experience_since,
      experience_in_country_markets:
        profile.basic_info.experience_in_country_markets,
      experience_in_industry: profile.basic_info.experience_in_industry,
      languages: profile.basic_info.languages,
      cv_summary_bullets: profile.basic_info.cv_summary_bullets,
      soft_skills: profile.basic_info.soft_skills,
    },
    work_experience: profile.work_experience ?? [],
    own_projects: profile.own_projects ?? [],
    certifications: profile.certifications ?? [],
    skills: profile.skills,
  };

  const prompt = `You are a professional CV writer. Analyse the candidate profile and job offer, then return a JSON object with tailored CV content.

CANDIDATE PROFILE:
${JSON.stringify(profileForClaude, null, 2)}

JOB OFFER (${cvLanguage}):
${offerText.slice(0, 3000)}

Return ONLY valid JSON (no markdown, no code fences, no explanation) matching this exact structure:
{
  "target_role": "job title tailored to this offer",
  "summary": "2-3 sentence professional summary in ${cvLanguage} tailored to this offer. Write in first person (I, my, me) — never third person (he, she, they). Example: 'I led a cross-functional team...' not 'He led a cross-functional team...'. Use cv_summary_bullets as inspiration. Highlight experience_in_industry and experience_in_country_markets where relevant. Weave soft_skills naturally into prose — do not list them verbatim.",
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
          "skills": ["tech1", "tech2"],
          "highlighted_achievements": ["most relevant achievement for this offer"]
        }
      ]
    }
  ],
  "own_projects": [
    {
      "name": "project name",
      "url": "url or null",
      "skills": ["tech1", "tech2"],
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
- dates must be in YYYY-MM format (e.g. "2021-03")
- IMPORTANT: if a project has name="" (empty string) in the profile, do NOT invent or generate a project name — output name="" in your JSON response. The CV template hides it automatically.`;

  console.log('[cvGenerator] calling Claude API, prompt length:', prompt.length);
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
    signal: AbortSignal.timeout(55_000),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error('[cvGenerator] Claude API error status:', response.status);
    console.error('[cvGenerator] Claude API error body:', errorBody);
    console.error('[cvGenerator] prompt length (chars):', prompt.length);
    throw new Error(`Claude API error: ${response.status} ${errorBody}`);
  }

  const data = (await response.json()) as { content: Array<{ text: string }> };
  const raw = data.content[0].text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const cv = JSON.parse(raw) as CvContent;

  // Enforce empty project names regardless of what Claude generated.
  // Claude may invent a name even when told not to — the profile is the source of truth.
  const profileWorkExp = profile.work_experience ?? [];
  for (const cvJob of cv.work_experience) {
    const profileJob = profileWorkExp.find(pj => pj.company === cvJob.company);
    if (!profileJob?.projects) continue;
    cvJob.projects.forEach((cvProj, idx) => {
      const profileProj = profileJob.projects?.[idx];
      if (profileProj && profileProj.name === '') {
        cvProj.name = '';
      }
    });
  }

  const opts = { lower: true, strict: true };
  const slug = (s: string) => slugify(s, opts);
  const { first_name, last_name } = profile.basic_info;
  const filenameParts = [
    'cv',
    slug(first_name),
    slug(last_name),
    jobTitle ? slug(jobTitle) : null,
    companyName ? slug(companyName) : null,
  ].filter((p): p is string => p !== null && p.length > 0);
  const filename = filenameParts.join('-') + '.pdf';

  let html = buildHtml(cv, profile, cvLanguage).replace(
    '{{CV_TITLE}}',
    filename.replace('.pdf', ''),
  );

  // Agent info + GDPR footer
  const isPl =
    cvLanguage.toLowerCase() === 'pl' ||
    cvLanguage.toLowerCase().startsWith('pol');
  const footerParts: string[] = [];

  if (user?.show_agent_info_in_cv) {
    const agentClient = await prisma.agentClient.findFirst({
      where: { user_id: user.id },
      include: { agent: true },
    });
    if (agentClient) {
      const { agent } = agentClient;
      const agentPhone = agent.phone ? ` · ${esc(agent.phone)}` : '';
      const represented =
        user.gender === 'F' ? 'Jestem reprezentowana' : 'Jestem reprezentowany';
      const agentLine = isPl
        ? `${represented} przez ${esc(agent.first_name)} ${esc(agent.last_name)} z Homo Digital — ${esc(agent.email)}${agentPhone}`
        : `I am represented by ${esc(agent.first_name)} ${esc(agent.last_name)} from Homo Digital — ${esc(agent.email)}${agentPhone}`;
      footerParts.push(
        `<div class="cert-item" style="margin-bottom: 16px;">${agentLine}</div>`,
      );
    }
  }

  const gdprText = isPl
    ? 'Wyrażam zgodę na przetwarzanie moich danych osobowych zawartych w niniejszym CV dla potrzeb niezbędnych do realizacji procesu rekrutacji, zgodnie z Rozporządzeniem Parlamentu Europejskiego i Rady (UE) 2016/679 (RODO).'
    : 'I hereby consent to the processing of my personal data included in this application for the purposes of the recruitment process, in accordance with the GDPR (Regulation (EU) 2016/679).';
  footerParts.push(`<div class="cert-item"  >${gdprText}</div>`);

  html = html.replace('{{FOOTER_NOTES}}', footerParts.join('\n'));

  return { html, filename };
}
